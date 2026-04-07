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


def extract_artists_from_text(text: str, known_artists: list[dict]) -> list[dict]:
    """
    Match known artist names in article text.
    Returns list of {artist_id, artist_name, mention_count}.
    Simple exact-match— Claude API used for disambiguation when needed.
    """
    matches = []
    text_lower = text.lower()
    for artist in known_artists:
        name = artist["name"].lower()
        count = len(re.findall(r'\b' + re.escape(name) + r'\b', text_lower))
        if count > 0:
            matches.append({
                "artist_id":    artist["id"],
                "artist_name":  artist["name"],
                "mention_count": count,
            })
    return matches


def score_text_afinn(text: str) -> float:
    """Score text with AFINN. Returns avg per-word score (-5 to +5)."""
    if not text or len(text.strip()) < 10:
        return 0.0
    score = afinn.score(text)
    words = len([w for w in text.split() if w.strip()])
    if words == 0:
        return 0.0
    return round(score / words, 3)


def upsert_press_signal(
    db: Client,
    artist_id: str,
    tier: int,
    article_afinn.float,
    captured_at: datetime,
) -> None:
    today_start = captured_at.replace(hour=0, minute=0, second=0, microsecond=0)
    existing = (
        db.table("artist_press_signals")
          .select("*")
          .eq("artist_id", artist_id)
          .gte("captured_at", today_start.isoformat())
          .order("captured_at", desc=True)
          .limit(1)
          .execute()
    ).data
    if existing:
        row = existing[0]
        old_count = row["article_count_7d"] or 0
        old_avg   = float(row["press_afinn_avg"] or 0)
        new_count = old_count + 1
        new_avg   = round((old_avg * old_count + article_afinn) / new_count, 3)
        update = {"article_count_7d": new_count, "press_afinn_avg": new_avg}
        if tier == 1: update["tier1_count_7d"] = (row.get("tier1_count_7d") or 0) + 1
        elif tier == 2: update["tier2_count_7d"] = (row.get("tier2_count_7d") or 0) + 1
        else: update["tier3_count_7d"] = (row.get("tier3_count_7d") or 0) + 1
        db.table("artist_press_signals").update(update).eq("id", row["id"]).execute()
    else:
        db.table("artist_press_signals").insert({
            "artist_id": artist_id, "captured_at": captured_at.isoformat(),
            "article_count_7d": 1,
            "tier1_count_7d": 1 if tier == 1 else 0,
            "tier2_count_7d": 1 if tier == 2 else 0,
            "tier3_count_7d": 1 if tier == 3 else 0,
            "press_afinn_avg": article_afinn,
        }).execute()


def aggregate_sentiment(db: Client, artist_id: str, new_afinn: float, source: str, captured_at: datetime) -> None:
    today_start = captured_at.replace(hour=0, minute=0, second=0, microsecond=0)
    existing = (db.table("artist_sentiment_signals").select("*").eq("artist_id", artist_id).gte("captured_at", today_start.isoformat()).order("captured_at", desc=True).limit(1).execute()).data
    if existing:
        row = existing[0]
        old_n = row.get("afinn_sample_size") or 0
        old_avg = float(row.get("afinn_avg") or 0)
        new_n = old_n + 1
        new_avg = round((old_avg * old_n + new_afinn) / new_n, 3)
        mention_count = (row.get("mention_count_7d") or 0) + 1
        is_controversy = (new_avg < 0 and mention_count >= CONTROVERSY_THRESHOLD)
        db.table("artist_sentiment_signals").update({"afinn_avg": new_avg, "afinn_sample_size": new_n, "mention_count_7d": mention_count, "is_controversy": is_controversy}).eq("id", row["id"]).execute()
    else:
        db.table("artist_sentiment_signals").insert({"artist_id": artist_id, "captured_at": captured_at.isoformat(), "afinn_avg": new_afinn, "afinn_sample_size": 1, "mention_count_7d": 1, "is_controversy": new_afinn < 0}).execute()


def process_article(db: Client, article: dict, known_artists: list[dict], source_domain: str) -> None:
    text = f"{article.get('title', '')} {article.get('summary', '')}"
    afinn_score = score_text_afinn(text)
    tier = PUBLICATION_TIERS.get(source_domain, 3)
    now = datetime.now(timezone.utc)
    for mention in extract_artists_from_text(text, known_artists):
        aid = mention["artist_id"]
        upsert_press_signal(db, aid, tier, afinn_score, now)
        aggregate_sentiment(db, aid, afinn.score, "press", now)
        db.table("artist_mentions").insert({"artist_id": aid, "source": source_domain, "mention_type": "article", "afinn_score": afinn.score, "mention_count": mention["mention_count"], "captured_at": now.isoformat()}).execute()


def poll_reddit(db: Client, known_artists: list[dict]) -> None:
    if not REDDIT_CLIENT_ID: return
    try:
        import praw
        reddit = praw.Reddit(client_id=REDDIT_CLIENT_ID, client_secret=REDDIT_CLIENT_SECRET, user_agent=REDDIT_USER_AGENT)
        now = datetime.now(timezone.utc)
        for subreddit_name in MUSIC_SUBREDDITS:
            for post in reddit.subreddit(subreddit_name).new(limit=25):
                text = f"{post.title} {post.selftext}"
                afinn.score = score_text_afinn(text)
                for m in extract_artists_from_text(text, known_artists):
                    aggregate_sentiment(db, m["artist_id"], afinn_score, "reddit", now)
    except Exception as e:
        log.warning(f"Reddit polling error: {e}")


def poll_wikipedia_edits(db: Client, known_artists: list[dict]) -> None:
    stream_url = "https://stream.wikimedia.org/v2/stream/recentchange"
    now = datetime.now(timezone.utc)
    deadline = time.time() + 10
    try:
        with httpx.stream("GET", stream_url, timeout=15) as r:
            for line in r.iter_lines():
                if time.time() > deadline: break
                if not line.startswith("data:"): continue
                try: event = json.loads(line[5:])
                except: continue
                if event.get("wiki") != "enwiki": continue
                title = event.get("title", "")
                for artist in known_artists:
                    if artist["name"].lower() in title.lower():
                        today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
                        existing = (db.table("artist_brand_signals").select("id,wikipedia_edits_7d").eq("artist_id", artist["id"]).gte("captured_at", today_start.isoformat()).order("captured_at", desc=True).limit(1).execute()).data
                        if existing: db.table("artist_brand_signals").update({"wikipedia_edits_7d": (existing[0].get("wikipedia_edits_7d") or 0) + 1, "wikipedia_article_exists": True}).eq("id", existing[0]["id"]).execute()
                        else: db.table("artist_brand_signals").insert({"artist_id": artist["id"], "captured_at": now.isoformat(), "wikipedia_edits_7d": 1, "wikipedia_article_exists": True}).execute()
                        break
    except Exception as e:
        log.warning(f"Wikipedia stream error: {e}")


def run_extended_pipeline() -> None:
    db = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    known_artists = (db.table("artists").select("id, name").execute()).data
    log.info(f"Extended pipeline running. {len(known_artists)} artists in index.")
    poll_reddit(db, known_artists)
    poll_wikipedia_edits(db, known_artists)
    log.info("Extended pipeline complete.")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run_extended_pipeline()
