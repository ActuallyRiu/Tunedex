"""
tunedex/heat_scorer.py  -- v2 fixed

Key fixes:
1. Baseline scoring from monthly_listeners when no signal data exists
2. Only writes confirmed real columns to artists table
3. Full error logging per artist
"""

import os
import math
import logging
from datetime import datetime, timezone
from typing import Optional

from supabase import create_client, Client

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("heat_scorer")

SUPABASE_URL         = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
BATCH_SIZE           = int(os.environ.get("SCORE_BATCH_SIZE", 50))

STAGE_WEIGHTS = {
    "emerging":    {"streaming": 20, "brand": 14, "sentiment": 24, "radio": 22, "press": 16},
    "rising":      {"streaming": 26, "brand": 18, "sentiment": 22, "radio": 18, "press": 12},
    "breaking":    {"streaming": 30, "brand": 22, "sentiment": 20, "radio": 14, "press": 10},
    "established": {"streaming": 34, "brand": 26, "sentiment": 18, "radio": 10, "press":  8},
}

HEAT_LABELS = [
    (85, "Exploding"),
    (70, "Rising"),
    (55, "Gaining"),
    (40, "Emerging"),
    (0,  "Early signals"),
]


def get_heat_label(score: float) -> str:
    for threshold, label in HEAT_LABELS:
        if score >= threshold:
            return label
    return "Early signals"


def log_norm(value: float, k: float = 80_000_000) -> float:
    if value <= 0:
        return 0.0
    return math.log1p(value) / math.log1p(k)


def baseline_score(monthly_listeners: int, stage: str) -> float:
    """Score purely from monthly listeners when no signals exist yet."""
    w = STAGE_WEIGHTS.get(stage, STAGE_WEIGHTS["established"])
    ln = log_norm(monthly_listeners)
    # Streaming + brand from listeners, others at neutral 0.25
    pts = (ln * w["streaming"]
         + ln * 0.7 * w["brand"]
         + 0.25 * w["sentiment"]
         + 0.25 * w["radio"]
         + 0.25 * w["press"])
    return round(min(pts, 96.0), 2)


def fetch_signal(db: Client, table: str, artist_id: str) -> dict:
    try:
        r = (db.table(table).select("*")
               .eq("artist_id", artist_id)
               .order("captured_at", desc=True)
               .limit(1).execute()).data
        return r[0] if r else {}
    except Exception as e:
        log.warning(f"Signal fetch failed {table}/{artist_id}: {e}")
        return {}


def score_with_signals(row: dict, sigs: dict, stage: str) -> dict:
    w  = STAGE_WEIGHTS.get(stage, STAGE_WEIGHTS["established"])
    ml = int(row.get("monthly_listeners") or 0)

    ss   = sigs.get("streaming", {})
    sent = sigs.get("sentiment", {})
    br   = sigs.get("brand", {})
    rad  = sigs.get("radio", {})
    prs  = sigs.get("press", {})

    s_stream   = log_norm(ss.get("spotify_listeners") or ml)
    s_sent     = (float(sent.get("afinn_avg") or 0) + 1) / 2 if sent else 0.25
    s_brand    = (float(br.get("brand_base_score") or 0) / 100) if br else log_norm(ml) * 0.7
    s_radio    = (float(rad.get("radio_base_score") or 0) / 100) if rad else 0.25
    # Prestige-weighted press score: tier1 articles worth 3x, tier2 1.5x, tier3 1x
    if prs:
        t1 = int(prs.get("tier1_count_7d") or 0)
        t2 = int(prs.get("tier2_count_7d") or 0)
        t3 = int(prs.get("tier3_count_7d") or 0)
        raw = int(prs.get("article_count_7d") or 0)
        weighted_count = t1 * 3 + t2 * 1.5 + t3 * 1 if (t1 + t2 + t3) > 0 else raw
        s_press = log_norm(weighted_count, 50)
    else:
        s_press = 0.25
    brand_mult = float(br.get("brand_multiplier") or 1.0)

    sp  = s_stream * w["streaming"]
    bp  = s_brand  * w["brand"] * brand_mult
    sep = s_sent   * w["sentiment"]
    rp  = s_radio  * w["radio"]
    pp  = s_press  * w["press"]
    base = sp + bp + sep + rp + pp

    return {
        "streaming_score": round(sp, 2),
        "brand_score":     round(bp, 2),
        "sentiment_score": round(sep, 2),
        "radio_score":     round(rp, 2),
        "press_score":     round(pp, 2),
        "base_score":      round(base, 2),
        "final_score":     round(min(base, 110.0), 2),
        "brand_multiplier": brand_mult,
    }


def run() -> None:
    db = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    log.info("Heat scorer v2 starting")

    offset = 0
    total_scored = 0
    total_errors = 0

    while True:
        try:
            rows = (db.table("artists")
                      .select("id, name, monthly_listeners, career_stage, genres")
                      .range(offset, offset + BATCH_SIZE - 1)
                      .execute()).data
        except Exception as e:
            log.error(f"Failed to fetch artists at offset {offset}: {e}")
            break

        if not rows:
            break

        log.info(f"Scoring batch offset={offset} count={len(rows)}")

        for row in rows:
            artist_id = row["id"]
            name      = row.get("name", "?")
            listeners = int(row.get("monthly_listeners") or 0)
            stage     = row.get("career_stage") or "established"

            try:
                sigs = {
                    "streaming": fetch_signal(db, "artist_streaming_signals", artist_id),
                    "sentiment": fetch_signal(db, "artist_sentiment_signals", artist_id),
                    "brand":     fetch_signal(db, "artist_brand_signals",     artist_id),
                    "radio":     fetch_signal(db, "artist_radio_signals",     artist_id),
                    "press":     fetch_signal(db, "artist_press_signals",     artist_id),
                }
                has_sigs = any(sigs.values())

                if has_sigs:
                    sc = score_with_signals(row, sigs, stage)
                else:
                    base = baseline_score(listeners, stage)
                    w    = STAGE_WEIGHTS.get(stage, STAGE_WEIGHTS["established"])
                    sc   = {
                        "streaming_score": round(base * w["streaming"] / 96, 2),
                        "brand_score":     round(base * w["brand"]     / 96, 2),
                        "sentiment_score": round(base * w["sentiment"] / 96, 2),
                        "radio_score":     round(base * w["radio"]     / 96, 2),
                        "press_score":     round(base * w["press"]     / 96, 2),
                        "base_score":      base,
                        "final_score":     base,
                        "brand_multiplier": 1.0,
                    }

                final  = sc["final_score"]
                label  = get_heat_label(final)
                now    = datetime.now(timezone.utc).isoformat()

                # Update artists — only columns confirmed to exist
                db.table("artists").update({
                    "heat_score":     final,
                    "heat_label":     label,
                    "last_scored_at": now,
                }).eq("id", artist_id).execute()

                # Insert heat history record
                db.table("artist_heat_history").insert({
                    "artist_id":             artist_id,
                    "scored_at":             now,
                    "career_stage":          stage,
                    "streaming_score":       sc["streaming_score"],
                    "brand_score":           sc["brand_score"],
                    "sentiment_score":       sc["sentiment_score"],
                    "radio_score":           sc["radio_score"],
                    "press_score":           sc["press_score"],
                    "bonus_pts":             0.0,
                    "base_score":            sc["base_score"],
                    "brand_multiplier":      sc["brand_multiplier"],
                    "final_score":           final,
                    "heat_label":            label,
                    "controversy_active":    False,
                    "multiplier_suppressed": False,
                }).execute()

                log.info(f"OK {name} [{stage}] {final} ({label}) sigs={'yes' if has_sigs else 'baseline'}")
                total_scored += 1

            except Exception as e:
                log.error(f"FAIL {name}: {e}", exc_info=True)
                total_errors += 1

        offset += BATCH_SIZE

    log.info(f"Done. scored={total_scored} errors={total_errors}")


if __name__ == "__main__":
    run()
