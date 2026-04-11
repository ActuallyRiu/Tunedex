"""
tunedex/pipeline/rss_poller.py — v5

Delegates RSS fetching to the Vercel /api/poll-rss endpoint.
Vercel has no egress restrictions so feeds are fetched reliably.
This worker just calls that endpoint every 90 seconds.
"""

import os, time, logging
import httpx

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("rss_poller")

POLL_INTERVAL  = int(os.environ.get("POLL_INTERVAL_SECONDS", 90))
VERCEL_URL     = os.environ.get("VERCEL_POLL_URL", "https://tunedex.vercel.app/api/poll-rss")

def run():
    log.info(f"RSS poller v5 — delegating to Vercel endpoint | interval={POLL_INTERVAL}s")
    log.info(f"Target: {VERCEL_URL}")

    while True:
        try:
            r = httpx.get(VERCEL_URL, timeout=65, headers={
                "User-Agent": "TunedexPoller/1.0"
            })
            if r.status_code == 200:
                data = r.json()
                log.info(f"Poll OK — articles={data.get('articles',0)} mentions={data.get('mentions',0)} press_signals={data.get('press_signals',0)}")
            else:
                log.warning(f"Poll returned {r.status_code}: {r.text[:200]}")
        except Exception as e:
            log.error(f"Poll failed: {e}")

        log.info(f"Sleeping {POLL_INTERVAL}s...")
        time.sleep(POLL_INTERVAL)

if __name__ == "__main__":
    run()
