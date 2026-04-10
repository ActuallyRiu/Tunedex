"""
tunedex/pipeline/rss_poller.py  — v3

Fixes vs v2:
  1. Persistent while-True loop — Railway keeps it alive (not COMPLETED)
  2. Reddit is fully optional — RSS runs without credentials
  3. Writes raw articles to the articles table first
  4. Press + sentiment signals written after article ingestion
  5. Artist names refreshed every cycle — new additions picked up automatically
  6. Graceful per-feed error handling — one bad feed doesn't kill the worker
"""

import os, re, time, logging, hashlib
from datetime import datetime, timezone

import feedparser
from supabase import create_client, Client

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("rss_poller")

SUPABASE_URL         = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
POLL_INTERVAL        = int(os.environ.get("POLL_INTERVAL_SECONDS", 90))

REDDIT_CLIENT_ID     = os.environ.get("REDDIT_CLIENT_ID")
REDDIT_CLIENT_SECRET = os.environ.get("REDDIT_CLIENT_SECRET")
REDDIT_USER_AGENT    = os.environ.get("REDDIT_USER_AGENT", "tunedex/1.0")
REDDIT_ENABLED       = bool(REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET)

FEEDS = [
    "https://www.billboard.com/feed/",
    "https://pitchfork.com/rss/news/",
    "https://www.rollingstone.com/music/music-news/feed/",
    "https://consequence.net/feed/",
    "https://www.nme.com/feed",
    "https://www.hotnewhiphop.com/rss.xml",
    "https://hiphopdx.com/rss",
    "https://www.complex.com/music/rss",
    "https://uproxx.com/music/feed/",
    "https://www.stereogum.com/feed/",
    "https://www.spin.com/feed/",
    "https://www.thefader.com/rss",
    "https://djbooth.net/feed",
    "https://okayplayer.com/feed",
    "https://www.xxlmag.com/feed/",
    "https://www.theguardian.com/music/rss",
    "https://variety.com/v/music/feed/",
]

SUBREDDITS = [
    "hiphopheads", "popheads", "indieheads", "rnb",
    "afrobeats", "electronicmusic", "worldmusic", "trap",
    "rap", "ukhiphopheads",
]

POSITIVE = {"fire","heat","banger","slap","goat","legend","iconic","amazing",
            "brilliant","masterpiece","love","best","incredible","perfect",
            "outstanding","excellent","great","hot","lit","vibe"}
NEGATIVE = {"trash","mid","flop","disappointing","boring","mediocre","overrated",
            "bad","worst","terrible","awful","skip","weak","dead","irrelevant"}

def quick_sentiment(text: str) -> float:
    words = set(re.findall(r"\b\w+\b", text.lower()))
    pos = len(words & POSITIVE)
    neg = len(words & NEGATIVE)
    total = pos + neg
    if total == 0:
        return 0.0
    return round((pos - neg) / total, 3)

def extract_mentions(text: str, artist_names: list) -> list:
    text_lower = text.lower()
    return [n for n in artist_names if n.lower() in text_lower]

def uid(url: str, title: str) -> str:
    return hashlib.md5(f"{url}|{title}".encode()).hexdigest()

def fetch_rss(db: Client, artist_names: list) -> int:
    total = 0
    for feed_url in FEEDS:
        try:
            feed = feedparser.parse(feed_url)
            for entry in feed.entries[:20]:
                title   = entry.get("title", "").strip()
                url     = entry.get("link", "").strip()
                summary = entry.get("summary", "")
                if not title or not url:
                    continue

                article_id = uid(url, title)
                now        = datetime.now(timezone.utc).isoformat()

                # Write article
                try:
                    db.table("articles").upsert({
                        "id":          article_id,
                        "title":       title,
                        "url":         url,
                        "body":        summary[:2000],
                        "source":      feed.feed.get("title", feed_url),
                        "published_at": now,
                    }, on_conflict="id").execute()
                except Exception as e:
                    log.warning(f"article upsert failed: {e}")
                    continue

                # Find artist mentions
                text    = f"{title} {summary}"
                mentioned = extract_mentions(text, artist_names)
                if not mentioned:
                    continue

                sentiment = quick_sentiment(text)

                for artist_name in mentioned:
                    rows = db.table("artists").select("id").eq("name", artist_name).limit(1).execute().data
                    if not rows:
                        continue
                    artist_id = rows[0]["id"]
                    try:
                        db.table("artist_press_signals").insert({
                            "artist_id":       artist_id,
                            "article_id":      article_id,
                            "captured_at":     now,
                            "sentiment_score": sentiment,
                            "source":          "rss",
                        }).execute()
                        total += 1
                        log.info(f"  press signal: {artist_name} ({feed.feed.get('title', feed_url)})")
                    except Exception as e:
                        log.warning(f"press signal failed {artist_name}: {e}")
        except Exception as e:
            log.warning(f"Feed error {feed_url}: {e}")
    return total

def fetch_reddit(db: Client, artist_names: list) -> int:
    if not REDDIT_ENABLED:
        return 0
    try:
        import praw
        reddit = praw.Reddit(
            client_id=REDDIT_CLIENT_ID,
            client_secret=REDDIT_CLIENT_SECRET,
            user_agent=REDDIT_USER_AGENT,
            read_only=True,
        )
        total = 0
        for sub_name in SUBREDDITS:
            try:
                for post in reddit.subreddit(sub_name).new(limit=25):
                    text      = f"{post.title} {post.selftext}"
                    mentioned = extract_mentions(text, artist_names)
                    if not mentioned:
                        continue
                    sentiment = quick_sentiment(text)
                    now       = datetime.now(timezone.utc).isoformat()
                    for artist_name in mentioned:
                        rows = db.table("artists").select("id").eq("name", artist_name).limit(1).execute().data
                        if not rows:
                            continue
                        artist_id = rows[0]["id"]
                        try:
                            db.table("artist_sentiment_signals").insert({
                                "artist_id":        artist_id,
                                "captured_at":      now,
                                "afinn_avg":        sentiment,
                                "afinn_sample_size": 1,
                                "mention_count_7d": 1,
                                "source":           f"reddit/r/{sub_name}",
                            }).execute()
                            total += 1
                        except Exception as e:
                            log.warning(f"sentiment signal failed {artist_name}: {e}")
            except Exception as e:
                log.warning(f"r/{sub_name} error: {e}")
        return total
    except Exception as e:
        log.error(f"Reddit init failed: {e}")
        return 0

def run():
    db = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    log.info(f"RSS poller v3 starting | interval={POLL_INTERVAL}s | reddit={'on' if REDDIT_ENABLED else 'off — waiting for credentials'}")

    while True:
        try:
            rows         = db.table("artists").select("name").limit(2000).execute().data
            artist_names = [r["name"] for r in rows]
            log.info(f"Cycle start — {len(artist_names)} artists loaded")

            press_hits   = fetch_rss(db, artist_names)
            reddit_hits  = fetch_reddit(db, artist_names)

            log.info(f"Cycle done — press: {press_hits} | sentiment: {reddit_hits}")
        except Exception as e:
            log.error(f"Cycle failed: {e}", exc_info=True)

        log.info(f"Sleeping {POLL_INTERVAL}s")
        time.sleep(POLL_INTERVAL)

if __name__ == "__main__":
    run()
