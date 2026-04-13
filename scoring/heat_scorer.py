"""
tunedex/scoring/heat_scorer.py  v4 — definitive

Scoring rules:
- Weights loaded from stage_weight_config (DB), normalised to 1.0
- Streaming: Spotify popularity (0-100) is primary. Falls back to log_norm(monthly_listeners) * 0.4
- Sentiment: sentiment_score from poll-sentiment (Spotify+LastFM+YouTube composite), capped at 0.6
- Brand: brand_base_score/100 when available, else 0
- Radio: radio_base_score/100 when available, else 0
- Press: press_score/100 when available (pre-computed, tier-weighted), else log_norm(article_count, 50)
- No fake fallback floors — missing signal = 0, not 0.25
- Spike detection with auto-clear after 3 stable cycles
"""

import os, math, logging
from datetime import datetime, timezone
from supabase import create_client, Client

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("heat_scorer")

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]

SPIKE_THRESHOLD    = 5.0
SPIKE_CLEAR_CYCLES = 3
SPIKE_STABLE_DELTA = 0.5

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

def score_components(row: dict, sigs: dict, weights: dict) -> dict:
    ml = int(row.get("monthly_listeners") or 0)

    ss   = sigs.get("streaming") or {}
    sent = sigs.get("sentiment") or {}
    br   = sigs.get("brand")     or {}
    rad  = sigs.get("radio")     or {}
    prs  = sigs.get("press")     or {}

    # Streaming — Spotify popularity (0-100, recency-weighted) is primary
    spotify_pop = ss.get("spotify_popularity")
    if spotify_pop is not None:
        s_stream = float(spotify_pop) / 100
    elif ss.get("spotify_listeners"):
        s_stream = log_norm(ss["spotify_listeners"], 50_000_000)
    else:
        # Fallback: monthly listeners, capped at 0.4 so legacy artists don't dominate
        s_stream = log_norm(ml, 100_000_000) * 0.4

    # Sentiment — composite from Spotify+LastFM+YouTube, capped at 0.6
    if sent:
        raw_sent = float(sent.get("sentiment_score") or 0)
        s_sent   = min(raw_sent, 0.6)
    else:
        s_sent = 0.0

    # Brand — no fallback
    s_brand = (float(br.get("brand_base_score") or 0) / 100) if br else 0.0

    # Radio — no fallback
    s_radio = (float(rad.get("radio_base_score") or 0) / 100) if rad else 0.0

    # Press — use pre-computed press_score (tier-weighted, 0-100)
    if prs:
        if prs.get("press_score"):
            s_press = float(prs["press_score"]) / 100
        else:
            t1  = int(prs.get("tier1_count_7d") or 0)
            t2  = int(prs.get("tier2_count_7d") or 0)
            t3  = int(prs.get("tier3_count_7d") or 0)
            raw = int(prs.get("article_count_7d") or 0)
            wc  = t1 * 3 + t2 * 1.5 + t3 if (t1 + t2 + t3) > 0 else raw
            s_press = log_norm(wc, 50)
    else:
        s_press = 0.0

    # Weights from DB, normalised
    ws_r  = float(weights.get("weight_streaming", 30))
    wb_r  = float(weights.get("weight_brand",     22))
    wse_r = float(weights.get("weight_sentiment", 20))
    wr_r  = float(weights.get("weight_radio",     14))
    wp_r  = float(weights.get("weight_press",     10))
    total = ws_r + wb_r + wse_r + wr_r + wp_r or 100
    ws    = ws_r  / total
    wb    = wb_r  / total
    wse   = wse_r / total
    wr    = wr_r  / total
    wp    = wp_r  / total

    # Component points (0-100 scale, for history logging)
    sp  = round(s_stream * ws  * 100, 2)
    bp  = round(s_brand  * wb  * 100, 2)
    sep = round(s_sent   * wse * 100, 2)
    rp  = round(s_radio  * wr  * 100, 2)
    pp  = round(s_press  * wp  * 100, 2)

    base       = sp + bp + sep + rp + pp
    brand_mult = float(br.get("brand_multiplier") or 1.0) if br else 1.0
    final      = min(base * brand_mult, 110.0)

    return {
        "streaming_score":  sp,
        "brand_score":      bp,
        "sentiment_score":  sep,
        "radio_score":      rp,
        "press_score":      pp,
        "base_score":       round(base, 2),
        "brand_multiplier": brand_mult,
        "final_score":      round(final, 2),
    }

def heat_label(score: float) -> str:
    if score >= 80: return "Exploding"
    if score >= 65: return "Rising"
    if score >= 45: return "Gaining"
    if score >= 25: return "Emerging"
    return "Early signals"

def diagnose_spike(prev: dict, curr: dict) -> str:
    reasons = []
    for col, label in [("streaming_score","Streaming spike"),("press_score","Press surge"),
                       ("sentiment_score","Sentiment shift"),("brand_score","Brand jump"),("radio_score","Radio spike")]:
        delta = float(curr.get(col,0) or 0) - float(prev.get(col,0) or 0)
        if abs(delta) >= 2.0:
            reasons.append(f"{label} ({'+' if delta>0 else ''}{delta:.1f}pts)")
    if float(prev.get("press_score",0) or 0) == 0 and float(curr.get("press_score",0) or 0) > 0:
        reasons.append("Press first data ingestion")
    return "; ".join(reasons) if reasons else "Multiple component changes"

def run():
    db = create_client(SUPABASE_URL, SUPABASE_KEY)
    log.info("Heat scorer v4 starting")

    # Load stage weights
    stage_weights = {}
    try:
        for w in db.table("stage_weight_config").select("*").execute().data:
            stage_weights[w["stage"]] = w
        log.info(f"Loaded weights for stages: {list(stage_weights.keys())}")
    except Exception as e:
        log.error(f"Failed to load stage weights: {e}"); return

    artists = db.table("artists").select(
        "id,name,monthly_listeners,career_stage,heat_score,controversy_flag"
    ).limit(2000).execute().data
    log.info(f"Scoring {len(artists)} artists")

    scored = 0
    for row in artists:
        aid   = row["id"]
        stage = row.get("career_stage") or "established"
        w     = stage_weights.get(stage, stage_weights.get("established", {}))

        try:
            sigs = {
                "streaming": fetch_signal(db, "artist_streaming_signals", aid),
                "sentiment": fetch_signal(db, "artist_sentiment_signals", aid),
                "brand":     fetch_signal(db, "artist_brand_signals",     aid),
                "radio":     fetch_signal(db, "artist_radio_signals",     aid),
                "press":     fetch_signal(db, "artist_press_signals",     aid),
            }

            sc    = score_components(row, sigs, w)
            final = sc["final_score"]
            label = heat_label(final)
            now   = datetime.now(timezone.utc).isoformat()

            # Spike detection
            hist = (db.table("artist_heat_history")
                      .select("final_score,press_score,streaming_score,brand_score,sentiment_score,radio_score")
                      .eq("artist_id", aid).order("scored_at", desc=True).limit(3).execute()).data

            prev_score   = float(hist[0]["final_score"]) if hist else None
            score_delta  = abs(final - prev_score) if prev_score is not None else 0
            anomaly_flag = False
            anomaly_reason = None

            artist_upd = {"heat_score": round(final, 2), "heat_label": label, "last_scored_at": now}

            if prev_score is not None and score_delta >= SPIKE_THRESHOLD:
                anomaly_flag   = True
                anomaly_reason = f"Score jumped {score_delta:+.1f}pts: {diagnose_spike(hist[0], sc)}"
                log.warning(f"SPIKE {row['name']}: {prev_score:.1f}->{final:.1f}")
                artist_upd.update({"anomaly_flag": True, "anomaly_reason": anomaly_reason,
                                   "anomaly_flagged_at": now, "anomaly_delta": round(score_delta, 2)})
            elif hist and len(hist) >= SPIKE_CLEAR_CYCLES:
                deltas = [abs(float(hist[i]["final_score"]) - float(hist[i+1]["final_score"]))
                          for i in range(min(SPIKE_CLEAR_CYCLES-1, len(hist)-1))]
                if all(d < SPIKE_STABLE_DELTA for d in deltas):
                    artist_upd.update({"anomaly_flag": False, "anomaly_reason": None,
                                       "anomaly_flagged_at": None, "anomaly_delta": None})

            db.table("artists").update(artist_upd).eq("id", aid).execute()
            db.table("artist_heat_history").insert({
                "artist_id": aid, "scored_at": now, "career_stage": stage,
                "streaming_score": sc["streaming_score"], "brand_score": sc["brand_score"],
                "sentiment_score": sc["sentiment_score"], "radio_score": sc["radio_score"],
                "press_score": sc["press_score"], "bonus_pts": 0,
                "base_score": sc["base_score"], "brand_multiplier": sc["brand_multiplier"],
                "final_score": final, "heat_label": label,
                "controversy_active": bool(row.get("controversy_flag")),
                "multiplier_suppressed": sc["brand_multiplier"] < 1.0,
            }).execute()
            scored += 1

        except Exception as e:
            log.error(f"Error scoring {row.get('name', aid)}: {e}")

    log.info(f"Scoring complete — {scored}/{len(artists)} artists scored")

if __name__ == "__main__":
    run()
