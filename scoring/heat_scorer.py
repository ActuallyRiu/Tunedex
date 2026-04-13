"""
tunedex/scoring/heat_scorer.py  -- v3 rebuilt

Runs every 15 minutes via Railway cron.
Reads signals from Supabase, scores each artist, writes heat scores + history.
Includes spike detection with anomaly flagging and auto-clear.
"""

import os, math, logging, time
from datetime import datetime, timezone
from supabase import create_client, Client

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("heat_scorer")

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]

# Spike detection thresholds
SPIKE_THRESHOLD    = 5.0   # pts in one cycle = flag for review
SPIKE_CLEAR_CYCLES = 3     # consecutive stable cycles before auto-clearing
SPIKE_STABLE_DELTA = 0.5   # considered stable if change < this

def log_norm(v, ceiling: float = 10_000_000) -> float:
    if not v or float(v) <= 0:
        return 0.0
    return min(math.log1p(float(v)) / math.log1p(ceiling), 1.0)

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

def baseline_score(listeners: int, stage: str) -> float:
    """Fallback score when no signals are available."""
    base = log_norm(listeners) * 60
    bumps = {"breaking": 5, "rising": 2, "established": 8}
    return min(base + bumps.get(stage, 0), 100.0)

def score_with_signals(row: dict, sigs: dict, weights: dict) -> dict:
    ml = int(row.get("monthly_listeners") or 0)

    ss   = sigs.get("streaming", {})
    sent = sigs.get("sentiment", {})
    br   = sigs.get("brand", {})
    rad  = sigs.get("radio", {})
    prs  = sigs.get("press", {})

    # Component scores (0-1)
    # If no real streaming signal, cap fallback at 0.5 so legacy fanbase size
    # doesn't dominate over artists with real current momentum signals
    if ss:
        s_stream = log_norm(ss.get("spotify_listeners") or ml)
    else:
        s_stream = min(log_norm(ml), 0.5)
    # Use sentiment_score (0-1 range from Last.fm+YouTube) — no fake floor
    s_sent   = float(sent.get("sentiment_score") or 0) if sent else 0.0
    s_brand  = (float(br.get("brand_base_score") or 0) / 100) if br else 0.0
    s_radio  = (float(rad.get("radio_base_score") or 0) / 100) if rad else 0.0

    # Press: use tier-weighted count if available, else raw article count
    if prs:
        t1 = int(prs.get("tier1_count_7d") or 0)
        t2 = int(prs.get("tier2_count_7d") or 0)
        t3 = int(prs.get("tier3_count_7d") or 0)
        raw = int(prs.get("article_count_7d") or 0)
        weighted_count = t1 * 3 + t2 * 1.5 + t3 * 1 if (t1 + t2 + t3) > 0 else raw
        s_press = log_norm(weighted_count, 50)
    else:
        s_press = 0.0

    # Brand multiplier (controversy suppression)
    brand_mult = float(br.get("brand_multiplier") or 1.0) if br else 1.0

    # Weighted sum — extract raw weights and normalise so they sum to 1.0
    ws_raw  = weights.get("weight_streaming", 30)
    wb_raw  = weights.get("weight_brand",     22)
    wse_raw = weights.get("weight_sentiment", 20)
    wr_raw  = weights.get("weight_radio",     14)
    wp_raw  = weights.get("weight_press",     10)
    total_w = ws_raw + wb_raw + wse_raw + wr_raw + wp_raw or 100
    ws  = ws_raw  / total_w
    wb  = wb_raw  / total_w
    wse = wse_raw / total_w
    wr  = wr_raw  / total_w
    wp  = wp_raw  / total_w

    base = (s_stream * ws + s_brand * wb + s_sent * wse + s_radio * wr + s_press * wp) * 100
    final = min(base * brand_mult, 110.0)

    # Component points for history
    sp  = round(s_stream * ws * 100, 2)
    bp  = round(s_brand  * wb * 100, 2)
    sep = round(s_sent   * wse * 100, 2)
    rp  = round(s_radio  * wr * 100, 2)
    pp  = round(s_press  * wp * 100, 2)

    return {
        "streaming_score":  sp,
        "brand_score":      bp,
        "sentiment_score":  sep,
        "radio_score":      rp,
        "press_score":      pp,
        "base_score":       round(base, 2),
        "brand_multiplier": brand_mult,
        "final_score":      round(min(final, 110.0), 2),
    }

def heat_label(score: float) -> str:
    if score >= 80: return "Exploding"
    if score >= 65: return "Rising"
    if score >= 45: return "Gaining"
    if score >= 25: return "Emerging"
    return "Early signals"

def diagnose_spike(prev: dict, curr: dict) -> str:
    reasons = []
    comps = {
        "streaming": ("streaming_score", "Streaming spike"),
        "press":     ("press_score",     "Press surge"),
        "sentiment": ("sentiment_score", "Sentiment shift"),
        "brand":     ("brand_score",     "Brand jump"),
        "radio":     ("radio_score",     "Radio spike"),
    }
    for key, (col, label) in comps.items():
        delta = float(curr.get(col, 0) or 0) - float(prev.get(col, 0) or 0)
        if abs(delta) >= 2.0:
            reasons.append(f"{label} ({'+' if delta > 0 else ''}{delta:.1f}pts)")
    if float(prev.get("press_score", 0) or 0) == 0 and float(curr.get("press_score", 0) or 0) > 0:
        reasons.append("Press pipeline first data ingestion")
    return "; ".join(reasons) if reasons else "Multiple component changes"

def run():
    db = create_client(SUPABASE_URL, SUPABASE_KEY)
    log.info("Heat scorer v3 starting")

    # Load stage weights from DB
    stage_weights = {}
    try:
        wrows = db.table("stage_weight_config").select("*").execute().data
        for w in wrows:
            stage_weights[w["stage"]] = w
    except Exception as e:
        log.error(f"Failed to load stage weights: {e}")
        return

    # Load all artists
    artists = db.table("artists").select(
        "id,name,monthly_listeners,career_stage,heat_score,controversy_flag"
    ).limit(2000).execute().data

    log.info(f"Scoring {len(artists)} artists")

    for row in artists:
        artist_id = row["id"]
        stage     = row.get("career_stage") or "established"
        listeners = int(row.get("monthly_listeners") or 0)
        weights   = stage_weights.get(stage, stage_weights.get("established", {}))

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
                sc = score_with_signals(row, sigs, weights)
            else:
                base = baseline_score(listeners, stage)
                sc = {
                    "streaming_score":  0, "brand_score":     0,
                    "sentiment_score":  0, "radio_score":     0,
                    "press_score":      0, "base_score":      round(base, 2),
                    "brand_multiplier": 1, "final_score":     round(base, 2),
                }

            final = sc["final_score"]
            label = heat_label(final)
            now   = datetime.now(timezone.utc).isoformat()

            # Spike detection — compare to last history row
            hist_rows = (db.table("artist_heat_history")
                           .select("final_score,press_score,streaming_score,brand_score,sentiment_score,radio_score,scored_at")
                           .eq("artist_id", artist_id)
                           .order("scored_at", desc=True)
                           .limit(3).execute()).data

            prev_score  = float(hist_rows[0]["final_score"]) if hist_rows else None
            score_delta = abs(final - prev_score) if prev_score is not None else 0
            anomaly_flag   = False
            anomaly_reason = None

            if prev_score is not None and score_delta >= SPIKE_THRESHOLD:
                anomaly_flag   = True
                anomaly_reason = f"Score jumped {score_delta:+.1f}pts: {diagnose_spike(hist_rows[0], sc)}"
                log.warning(f"SPIKE {row['name']}: {prev_score:.1f} -> {final:.1f} ({score_delta:+.1f}pts)")

            # Build artist update payload
            artist_update = {
                "heat_score":     round(final, 2),
                "heat_label":     label,
                "last_scored_at": now,
            }

            # Add anomaly fields if columns exist (they do now)
            if anomaly_flag:
                artist_update["anomaly_flag"]       = True
                artist_update["anomaly_reason"]     = anomaly_reason
                artist_update["anomaly_flagged_at"] = now
                artist_update["anomaly_delta"]      = round(score_delta, 2)
            elif hist_rows and len(hist_rows) >= SPIKE_CLEAR_CYCLES:
                # Auto-clear if last N cycles were stable
                recent_deltas = [
                    abs(float(hist_rows[i]["final_score"]) - float(hist_rows[i+1]["final_score"]))
                    for i in range(min(SPIKE_CLEAR_CYCLES - 1, len(hist_rows) - 1))
                ]
                if all(d < SPIKE_STABLE_DELTA for d in recent_deltas):
                    artist_update["anomaly_flag"]       = False
                    artist_update["anomaly_reason"]     = None
                    artist_update["anomaly_flagged_at"] = None
                    artist_update["anomaly_delta"]      = None

            db.table("artists").update(artist_update).eq("id", artist_id).execute()

            # Write heat history row
            db.table("artist_heat_history").insert({
                "artist_id":             artist_id,
                "scored_at":             now,
                "career_stage":          stage,
                "streaming_score":       sc["streaming_score"],
                "brand_score":           sc["brand_score"],
                "sentiment_score":       sc["sentiment_score"],
                "radio_score":           sc["radio_score"],
                "press_score":           sc["press_score"],
                "bonus_pts":             0,
                "base_score":            sc["base_score"],
                "brand_multiplier":      sc["brand_multiplier"],
                "final_score":           final,
                "heat_label":            label,
                "controversy_active":    bool(row.get("controversy_flag")),
                "multiplier_suppressed": sc["brand_multiplier"] < 1.0,
            }).execute()

        except Exception as e:
            log.error(f"Error scoring {row.get('name', artist_id)}: {e}")
            continue

    log.info("Scoring complete")

if __name__ == "__main__":
    run()
