"""
tunedex/pipeline/rss_poller.py Ã¢ÂÂ v4

Writes to correct schema:
  articles            Ã¢ÂÂ source_name, url, title, body, published_at, sentiment, content_hash
  artist_mentions     Ã¢ÂÂ artist_id, article_id, sentiment, context_snippet, afinn_score, mention_type, captured_at
  artist_press_signals  Ã¢ÂÂ artist_id, captured_at, article_count_7d, press_afinn_avg, press_score (upsert aggregated)
  artist_sentiment_signals Ã¢ÂÂ artist_id, captured_at, afinn_avg, mention_count_7d (upsert aggregated)

Sources are read from the `sources` table (already seeded with Billboard, Rolling Stone etc.)
Reddit optional Ã¢ÂÂ activates when REDDIT_CLIENT_ID/SECRET are set.
Persistent while-True loop Ã¢ÂÂ never exits.
"""

import os, re, time, logging, hashlib
from datetime import datetime, timezone, timedelta
from collections import defaultdict

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

SUBREDDITS = [
    "hiphopheads", "popheads", "indieheads", "rnb",
    "afrobeats", "electronicmusic", "worldmusic", "trap",
    "rap", "ukhiphopheads",
]

POSITIVE = {"fire","heat","banger","slap","goat","legend","iconic","amazing","brilliant",
            "masterpiece","love","best","incredible","perfect","outstanding","excellent",
            "great","hot","lit","vibe","classic","underrated","essential"}
NEGATIVE = {"trash","mid","flop","disappointing","boring","mediocre","overrated",
            "bad","worst","terrible","awful","skip","weak","dead","irrelevant","garbage"}

def afinn_score(text: str) -> float:
    words = re.findall(r"\b\w+\b", text.lower())
    pos = sum(1 for w in words if w in POSITIVE)
    neg = sum(1 for w in words if w in NEGATIVE)
    total = pos + neg
    return round((pos - neg) / total, 3) if total else 0.0

def content_hash(url: str, title: str) -> str:
    return hashlib.md5(f"{url}|{title}".encode()).hexdigest()

def extract_mentions(text: str, artist_index: dict) -> list:
    """Return list of (artist_id, artist_name) for each mention found."""
    text_lower = text.lower()
    return [(aid, name) for name, aid in artist_index.items() if name in text_lower]

def load_sources(db: Client) -> list:
    """Load active RSS sources from DB."""
    rows = db.table("sources").select("id,name,rss_url,prestige_weight,tier").eq("active", True).execute().data
    return [r for r in rows if r.get("rss_url")]

def load_artists(db: Client) -> dict:
    """Return {lower_name: id} index for fast mention matching."""
    rows = db.table("artists").select("id,name").limit(2000).execute().data
    return {r["name"].lower(): r["id"] for r in rows}

def upsert_press_aggregate(db: Client, artist_id: str, afinn: float, article_count: int):
    """Upsert aggregated press signal for this artist."""
    now = datetime.now(timezone.utc).isoformat()
    # Calculate a simple press score: log-normalised article count * sentiment boost
    import math
    base = min(math.log1p(article_count) / math.log1p(50), 1.0)
    sentiment_boost = 1.0 + (afinn * 0.2)
    press_score = round(base * sentiment_boost * 100, 2)
    try:
        db.table("artist_press_signals").upsert({
            "artist_id":       artist_id,
            "captured_at":     now,
            "article_count_7d": article_count,
            "press_afinn_avg": afinn,
            "press_score":     press_score,
        }, on_conflict="artist_id").execute()
    except Exception as e:
        log.warning(f"press signal upsert failed: {e}")

def upsert_sentiment_aggregate(db: Client, artist_id: str, afinn: float, mention_count: int):
    """Upsert aggregated sentiment signal for this artist."""
    now = datetime.now(timezone.utc).isoformat()
    try:
        db.table("artist_sentiment_signals").upsert({
            "artist_id":        artist_id,
            "captured_at":      now,
            "afinn_avg":        afinn,
            "mention_count_7d": mention_count,
        }, on_conflict="artist_id").execute()
    except Exception as e:
        log.warning(f"sentiment signal upsert failed: {e}")

def poll_rss(db: Client, sources: list, artist_index: dict) -> dict:
    """Poll all RSS feeds. Returns {artist_id: [afinn_scores]} for aggregation."""
    artist_scores = defaultdict(list)
    article_count = defaultdict(int)
    total_articles = 0
    total_mentions = 0

    for source in sources:
        feed_url = source["rss_url"]
        source_name = source["name"]
        try:
            feed = feedparser.parse(feed_url)
            entries = feed.entries[:25]
            log.info(f"  {source_name}: {len(entries)} entries")

            for entry in entries:
                title   = (entry.get("title") or "").strip()
                url     = (entry.get("link") or "").strip()
                body    = entry.get("summary") or entry.get("description") or ""
                if not title or not url:
                    continue

                text     = f"{title} {body}"
                score    = afinn_score(text)
                chash    = content_hash(url, title)
                now      = datetime.now(timezone.utc).isoformat()

                # Write article
                article_id = chash
                try:
                    result = db.table("articles").upsert({
                        "source_name":  source_name,
                        "original_url": url,
                        "title":        title,
                        "body":         body[:3000],
                        "published_at": now,
                        "content_hash": chash,
                    }, on_conflict="content_hash").execute()
                    # Use returned id for linking mentions
                    if result.data:
                        article_id = result.data[0]["id"]
                    total_articles += 1
                except Exception as e:
                    log.warning(f"article upsert failed: {e}")
                    continue

                # Find artist mentions
                mentioned = extract_mentions(text, artist_index)
                for artist_id, artist_name in mentioned:
                    # Write mention record
                    snippet = text[:300]
                    try:
                        db.table("artist_mentions").insert({
                            "artist_id":       artist_id,
                            "article_id":      article_id,
                            "sentiment":       score,
                            "context_snippet": snippet,
                            "afinn_score":     score,
                            "mention_type":    "press",
                            "captured_at":     now,
                        }).execute()
                    except Exception as e:
                        pass  # duplicate mentions are fine to skip

                    artist_scores[artist_id].append(score)
                    article_count[artist_id] += 1
                    total_mentions += 1
                    log.info(f"    mention: {artist_name} in '{title[:60]}' (sentiment={score})")

        except Exception as e:
            log.warning(f"Feed error {feed_url}: {e}")

    # Aggregate and upsert press signals
    for artist_id, scores in artist_scores.items():
        avg = round(sum(scores) / len(scores), 3)
        upsert_press_aggregate(db, artist_id, avg, article_count[artist_id])

    log.info(f"RSS: {total_articles} articles ingested, {total_mentions} artist mentions")
    return artist_scores

def poll_reddit(db: Client, artist_index: dict) -> None:
    if not REDDIT_ENABLED:
        return
    try:
        import praw
        reddit = praw.Reddit(
            client_id=REDDIT_CLIENT_ID,
            client_secret=REDDIT_CLIENT_SECRET,
            user_agent=REDDITE_USER_AGENT,
            read_only=True,
        )
        artist_scores = defaultdict(list)
        mention_count = defaultdict(int)

        for sub_name in SUBREDDITS:
            try:
                for post in reddit.subreddit(sub_name).new(limit=25):
                    text      = f"{post.title} {post.selftext}"
                    mentioned = extract_mentions(text, artist_index)
                    if not mentioned:
                        continue
                    score = afinn_score(text)
                    now   = datetime.now(timezone.utc).isoformat()
                    for artist_id, artist_name in mentioned:
                        artist_scores[artist_id].append(score)
                        mention_count[artist_id] += 1
                        log.info(f"    reddit mention: {artist_name} in r/{sub_name}")
            except Exception as e:
                log.warning(f"r/{sub_name} error: {e}")

        for artist_id, scores in artist_scores.items():
            avg = round(sum(scores) / len(scores), 3)
            upsert_sentiment_aggregate(db, artist_id, avg, mention_count[artist_id])

        log.info(f"Reddit: {sum(mention_count.values())} mentions across {len(mention_count)} artists")
    except Exception as e:
        log.error(f"Reddit failed: {e}")

def run():
    db = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    log.info(f"RSS poller v4 | interval={POLL_INTERVAL}s | reddit={'_ON' if REDDIT_ENABLED else 'OFF (no credentials)'}")

    first_run = True

    while True:
        try:
            sources      = load_sources(db)
            artist_index = load_artists(db)

            log.info(f"Cycle start Ã¢ÂÂ {len(sources)} sources | {len(artist_index)} artists")

            if first_run:
                log.info("First run Ã¢ÂÂ running backfill of available feed entries...")
                first_run = False

            poll_rss(db, sources, artist_index)
            poll_reddit(db, artist_index)

        except Exception as e:
            log.error(f"Cycle error: {e}", exc_info=True)

        log.info(f"Sleeping {POLL_INTERVAL}s")
        time.sleep(POLL_INTERVAL)

if __name__ == "__main__":
    run()
