"""
tunedex/rss_poller_v2.py

Extended version of the original rss_poller.py.
Adds to the existing pipeline:
  1. AFINN sentiment scoring on every ingested article
  2. Artist mention extraction with entity tagging
  3. Press signal writes to artist_press_signals
  4. Sentiment aggregation writes to artist_sentiment_signals
  5. Wikipedia edit stream monitoring (Layer 0 upstream source)

Runs every 90 seconds on Railway (same cadence as original).
Requires: afinn, praw, wikipedia-api packages in addition to existing deps.

New env vars:
  REDDIT_CLIENT_ID
  REDDIT_CLIENT_SECRET
  REDDIT_USER_AGENT
  X_BEARER_TOKEN         (for filtered stream, $100/mo Basic tier)
  WIKI_EDIT_STREAM_URL   (default: https://stream.wikimedia.org/v2/stream/recentchange)
"""

import os
import re
import logging
import time
import json
from datetime import datetime, timezone, timedelta
from typing import Optional

import feedparser
import httpx
from afinn import Afinn
from supabase import create_client, Client

log = logging.getLogger("rss_poller_v2")

SUPABASE_URL         = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
ANTHROPIC_API_KEY    = os.environ["ANTHROPIC_API_KEY"]
REDDIT_CLIENT_ID     = os.environ.get("REDDIT_CLIENT_ID")
REDDIT_CLIENT_SECRET = os.environ.get("REDDIT_CLIENT_SECRET")
REDDIT_USER_AGENT    = os.environ.get("REDDIT_USER_AGENT", "tunedex/1.0")
X_BEARER_TOKEN       = os.environ.get("X_BEARER_TOKEN")

CONTROVERSY_THRESHOLD = 50
AFINN_WINDOW_HOURS    = 168

afinn = Afinn(language="en")

PUBLICATION_TIERS = {
    "pitchfork.com": 1, "rollingstone.com": 1, "nme.com": 1,
    "stereogum.com": 2, "consequence.net": 2, "pastemagazine.com": 2,
    "pigeonandplanes.com": 2, "ones2watch.com": 2,
    "lyricallemonade.com": 3, "musicconnection.com": 3,
}

MUSIC_SUBREDDITS = [
    "hiphopheads", "indieheads", "rnb", "popheads",
    "afrobeats", "electronicmusic", "worldmusic",
]


def extract_artists_from_text(text, known_artists):
    matches = []
    text_lower = text.lower()
    for artist in known_artists:
        name = artist["name"].lower()
        count = len(re.findall(r'\b' + re.escape(name) + r'\b', text_lower))
        if count > 0:
            matches.append({"artist_id": artist["id"], "artist_name": artist["name"], "mention_count": count})
    return matches


def score_text_afinn(text):
    if not text or len(text.strip()) < 10: return 0.0
    score = afinn.score(text)
    words = len([w for w in text.split() if w.strip()])
    return round(score / words, 3) if words else 0.0


def upsert_press_signal(db, artist_id, tier, afinn_score, now):
    ts = now.replace(hour=0, minute=0, second=0, microsecond=0)
    ex = (db.table("artist_press_signals").select("*").eq("artist_id", artist_id).gte("captured_at", ts.isoformat()).order("captured_at", desc=True).limit(1).execute()).data
    if ex:
        row = ex[0]; n = (row.get("article_count_7d") or 0) + 1
        avg = round((float(row.get("press_afinn_avg") or 0) * (n - 1) + afinn) / n, 3)
        u = {"article_count_7d": n, "press_afinn_avg": avg}
        if tier == 1: u["tier1_count_7d"] = (row.get("tier1_count_7d") or 0) + 1
        elif tier == 2: u["tier2_count_7d"] = (row.get("tier2_count_7d") or 0) + 1
        else: u["tier3_count_7d"] = (row.get("tier3_count_7d") or 0) + 1
        db.table("artist_press_signals").update(u).eq("id", row["id"]).execute()
    else:
        db.table("artist_press_signals").insert({"artist_id": artist_id, "captured_at": now.isoformat(), "article_count_7d": 1, "tier1_count_7d": 1 if tier == 1 else 0, "tier2_count_7d": 1 if tier == 2 else 0, "tier3_count_7d": 1 if tier == 3 else 0, "press_afinn_avg": afinn_score}).execute()


def aggregate_sentiment(db, artist_id, new_afinn, source, now):
    ts = now.replace(hour=0, minute=0, second=0, microsecond=0)
    ex = (db.table("artist_sentiment_signals").select("*").eq("artist_id", artist_id).gte("captured_at", ts.isoformat()).order("captured_at", desc=True).limit(1).execute()).data
    if ex:
        row = ex[0]; on = row.get("afinn_sample_size") or 0; oa = float(row.get("afinn_avg") or 0)
        nn = on + 1; na = round((oa * on + new_afinn) / nn, 3)
        mc = (row.get("mention_count_7d") or 0) + 1; ic = (na < 0 and mc >= 50)
        db.table("artist_sentiment_signals").update({"afinn_avg": na, "afinn_sample_size": nn, "mention_count_7d": mc, "is_controversy": ic}).eq("id", row["id"]).execute()
    else:
        db.table("artist_sentiment_signals").insert({"artist_id": artist_id, "captured_at": now.isoformat(), "afinn_avg": new_afinn, "afinn_sample_size": 1, "mention_count_7d": 1, "is_controversy": new_afinn < 0}).execute()


def process_article(db, article, known_artists, source_domain):
    from datetime import datetime, timezone
    text = f"{article.get('title', '')} {article.get('summary', '')}"
    afinn_score = score_text_afinn(text); tier = PUBLICATION_TIERS.get(source_domain, 3); now = datetime.now(timezone.utc)
    for m in extract_artists_from_text(text, known_artists):
        aid = m["artist_id"]
        upsert_press_signal(db, aid, tier, afinn_score, now)
        aggregate_sentiment(db, aid, afinn_score, "press", now)
        db.table("artist_mentions").insert({"artist_id": aid, "source": source_domain, "mention_type": "article", "afinn_score": afinn_score, "mention_count": m["mention_count"], "captured_at": now.isoformat()}).execute()


def poll_reddit(db, known_artists):
    import praw, logging
    log = logging.getLogger("rss_poller_v2")
    if not REDDIT_CLIENT_ID: return
    try:
        from datetime import datetime, timezone
        reddit = praw.Reddit(client_id=REDDIT_CLIENT_ID, client_secret=REDDITCLIENT_SECRET, user_agent=REDDIT_USER_AGENT)
        now = datetime.now(timezone.utc)
        for s in MUSIC_SUBREDDITS:
            for p in reddit.subreddit(s).new(limit=25):
                t = p.title + " " + p.selftext
                for m in extract_artists_from_text(t, known_artists):
                    aggregate_sentiment(db, m["artist_id"], score_text_afinn(t), "reddit", now)
    except Exception as e: log.warning(f"Reddit: {e}")


def poll_wikipedia_edits(db, known_artists):
    import httpx, json, time, logging
    from datetime import datetime, timezone
    log = logging.getLogger("rss_poller_v2")
    now = datetime.now(timezone.utc); dl = time.time() + 10
    try:
        with httpx.stream("GET", "https://stream.wikimedia.org/v2/stream/recentchange", timeout=15) as r:
            for l in r.iter_lines():
                if time.time() > dl: break
                if not l.startswith("data:"): continue
                try: e = json.loads(l[5:])
                except: continue
                if e.get("wiki") != "enwiki": continue
                tit = e.get("title", "")
                for a in known_artists:
                    if a["name"].lower() in tit.lower():
                        ts = now.replace(hour=0, minute=0, second=0, microsecond=0)
                        ex = (db.table("artist_brand_signals").select("id,wikipedia_edits_7d").eq("artist_id", a["id"]).gte("captured_at", ts.isoformat()).order("captured_at", desc=True).limit(1).execute()).data
                        if ex: db.table("artist_brand_signals").update({"wikipedia_edits_7d": (ex[0].get("wikipedia_edits_7d") or 0) + 1, "wikipedia_article_exists": True}).eq("id", ex[0]["id"]).execute()
                        else: db.table("artist_brand_signals").insert({"artist_id": a["id"], "captured_at": now.isoformat(), "wikipedia_edits_7d": 1, "wikipedia_article_exists": True}).execute()
                        break
    except Exception as e: log.warning(f"Wikipedia: {e}")


def run_extended_pipeline():
    db = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    known = (db.table("artists").select("id,name").execute()).data
    log.info(f"Extended pipeline: {len(known)} artists")
    poll_reddit(db, known)
    poll_wikipedia_edits(db, known)
    log.info("Extended pipeline complete.")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run_extended_pipeline()
