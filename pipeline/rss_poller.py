"""
tunedex/pipeline/rss_poller.py — v6

Calls two Vercel endpoints every cycle:
  1. /api/poll-rss      — RSS press ingestion (every 90s)
  2. /api/poll-sentiment — Last.fm + YouTube + Trends sentiment (every 10 min)
"""

import os, time, logging
import httpx

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("rss_poller")

POLL_INTERVAL     = int(os.environ.get("POLL_INTERVAL_SECONDS", 90))
VERCEL_URL        = os.environ.get("VERCEL_POLL_URL",      "https://tunedex.vercel.app/api/poll-rss")
SENTIMENT_URL     = os.environ.get("VERCEL_SENTIMENT_URL", "https://tunedex.vercel.app/api/poll-sentiment")
SENTIMENT_EVERY   = int(os.environ.get("SENTIMENT_INTERVAL_CYCLES", 7))  # every ~10 min (7 × 90s)

def call(url: str, label: str) -> None:
    try:
        r = httpx.get(url, timeout=65, headers={"User-Agent": "TunedexPoller/1.0"})
        if r.status_code == 200:
            data = r.json()
            log.info(f"{label} OK — {data}")
        else:
            log.warning(f"{label} returned {r.status_code}: {r.text[:200]}")
    except Exception as e:
        log.error(f"{label} failed: {e}")

def run():
    log.info(f"Poller v6 | interval={POLL_INTERVAL}s | sentiment every {SENTIMENT_EVERY} cycles (~{SENTIMENT_EVERY * POLL_INTERVAL // 60} min)")
    cycle = 0
    while True:
        cycle += 1
        log.info(f"Cycle {cycle}")

        # Press RSS — every cycle
        call(VERCEL_URL, "press")

        # Sentiment — every N cycles
        if cycle % SENTIMENT_EVERY == 0:
            call(SENTIMENT_URL, "sentiment")

        log.info(f"Sleeping {POLL_INTERVAL}s...")
        time.sleep(POLL_INTERVAL)

if __name__ == "__main__":
    run()
