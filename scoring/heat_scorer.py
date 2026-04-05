"""
tunedex/heat_scorer.py

Core scoring worker. Runs as a Railway cron job every 15 minutes.
Reads latest signals from Supabase, applies career-stage-adjusted
weights, writes heat scores back.

Environment variables required:
  SUPABASE_URL
  SUPABASE_SERVICE_KEY
  AFINN_CONTROTERSY_THRESHOLD  (default: 50)
  SCORE_BATCH_SIZE             (default: 50)
"""

import os
import math
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional
from dataclasses import dataclass, field

from supabase import create_client, Client

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("heat_scorer")


SUPABASE_URL         = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
CONTROVERSY_MENTION_THRESHOLD = int(os.environ.get("AFINN_CONTROVERSY_THRESHOLD", 50))
BATCH_SIZE = int(os.environ.get("SCORE_BATCH_SIZE", 50))

STAGE_THRESHOLDS = {
    "emerging":    (0,       10_000),
    "rising":      (10_000,  100_000),
    "breaking":    (100_000, 1_000_000),
    "established": (1_000_000, None),
}

STAGE_WEIGHTS = {
    "emerging":    {"streaming": 20, "brand": 14, "sentiment": 24, "radio": 22, "press": 16},
    "rising":      {"streaming": 26, "brand": 18, "sentiment": 22, "radio": 18, "press": 12},
    "breaking":    {"streaming": 30, "brand": 22, "sentiment": 20, "radio": 14, "press": 10},
    "established": {"streaming": 34, "brand": 26, "sentiment": 18, "radio": 10, "press":  8},
}

BONUS_PTS = {
    "cross_signal_spike": 4.0,
    "milestone_event":    4.0,
    "viral_moment":       2.0,
}

HEAT_LABELS = [
    (85, "Breakout"),
    (70, "Rising"),
    (55, "Gaining traction"),
    (40, "Emerging"),
    (0,  "Early signals"),
]

STAGE_TRANSITION_BUFFER = 3


@dataclass
class StreamingSignal:
    spotify_listeners:   int   = 0
    spotify_streams_7d:  int   = 0
    youtube_views_7d:    int   = 0
    audiomack_plays_7d:  int   = 0
    listener_delta_7d:   float = 0.0
    stream_delta_7d:     float = 0.0
    editorial_playlists: int   = 0
    algo_playlists:      int   = 0
    soundcharts_rank:    Optional[int] = None
    chart_delta_7d:      int   = 0

@dataclass
class SentimentSignal:
    afinn_avg:           float = 0.0
    afinna_sample_size:  int   = 0
    mention_count_7d:    int   = 0
    valence_slope_7d:    float = 0.0
    is_controversy:      bool  = False

@dataclass
class RadioSignal:
    indie_spins_7d:         int = 0
    indie_stations_7d:      int = 0
    indie_stations_new_7d:  int = 0
    indie_stations_lost_7d: int = 0
    commercial_spins_7d:    int = 0
    commercial_stations_7d: int = 0
    format_count_7d:        int = 0

@dataclass
class BrandSignal:
    followers_total:              int   = 0
    follower_growth_30d:          float = 0.0
    active_platforms:             int   = 0
    engagement_rate:              float = 0.0
    tastemaker_recognition_score: float = 0.0
    genre_cooccurrence_score:     float = 0.0
    wikipedia_article_exists:     bool  = False
    wikipedia_edits_7d:           int   = 0
    wikipedia_inbound_links:      int   = 0
    sync_weight_90d:              float = 0.0
    brand_partnerships_90d:       int   = 0
    media_appearances_90d:        int   = 0

@dataclass
class PressSignal:
    article_count_7d: int   = 0
    tier1_count_7d:   int   = 0
    tier2_count_7d:   int   = 0
    tier3_count_7d:   int   = 0
    press_afinn_avg:  float = 0.0

@dataclass
class ArtistRecord:
    id:                        str
    name:                      str
    monthly_listeners:         int   = 0
    career_stage:              str   = "emerging"
    stage_transition_buffer:   int   = 0
    controversy_flag:          bool  = False
    streaming: StreamingSignal = field(default_factory=StreamingSignal)
    sentiment: SentimentSignal = field(default_factory=SentimentSignal)
    radio:     RadioSignal     = field(default_factory=RadioSignal)
    brand:     BrandSignal     = field(default_factory=BrandSignal)
    press:     PressSignal     = field(default_factory=PressSignal)
    bonus_pts: float           = 0.0


def log_norm(value: int, ceiling: int = 1_000_000) -> float:
    if value <= 0: return 0.0
    return min(math.log10(value + 1) / math.log10(ceiling + 1), 1.0)

def clamp(value: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(Hi, value))

def pct_norm(pct: float, ceiling: float = 200.0) -> float:
    return clamp(max(pct, 0) / ceiling)

def rank_norm(rank: Optional[int], floor: int = 1, ceiling: int = 10000) -> float:
    if rank is None: return 0.0
    return clamp(1 - (rank - floor) / (ceiling - floor))

def slope_norm(slope: float, ceiling: float = 0.5) -> float:
    return clamp(max(slope, 0) / ceiling)


def score_streaming(s: StreamingSignal) -> float:
    volume = (
        log_norm(s.spotify_listeners, 10_000_000) * 0.5 +
        log_norm(s.spotify_streams_7d, 5_000_000) * 0.3 +
        log_norm(s.youtube_views_7d, 10_000_000) * 0.15 +
        log_norm(s.audiomack_plays_7d, 1_000_000) * 0.05
    )
    momentum = (
        pct_norm(s.listener_delta_7d, 100) * 0.5 +
        pct_norm(s.stream_delta_7d, 100) * 0.5
    )
    playlists = (
        log_norm(s.editorial_playlists, 50) * 0.75 +
        log_norm(s.algo_playlists, 200) * 0.25
    )
    chart = rank_norm(s.soundcharts_rank)
    if s.chart_delta_7d and s.chart_delta_7d > 0:
        chart = clamp(chart + pct_norm(s.chart_delta_7d, 20) * 0.1)
    return clamp(volume * 0.35 + momentum * 0.30 + playlists * 0.20 + chart * 0.15)


def score_sentiment(s: SentimentSignal) -> float:
    raw_valence = (s.afinn_avg + 5) / 10
    valence = clamp(raw_valence)
    if s.is_controversy or s.afinn_avg < 0:
        volume = 0.0
    else:
        volume = log_norm(s.mention_count_7d, 100_000) * valence
    trajectory = slope_norm(s.valence_slope_7d)
    return clamp(valence * 0.58 + volume * 0.25 + trajectory * 0.17)


def score_radio(r: RadioSignal) -> float:
    indie = log_norm(r.indie_spins_7d, 5000)
    velocity = clamp((r.indie_stations_new_7d - r.indie_stations_lost_7d + 20) / 40)
    commercial = log_norm(r.commercial_spins_7d, 10000)
    formats = clamp(r.format_count_7d / 8)
    return clamp(indie * 0.35 + velocity * 0.25 + commercial * 0.20 + formats * 0.20)


def score_brand(b: BrandSignal) -> tuple[float, float]:
    social = (
        log_norm(b.followers_total, 50_000_000) * (2/8) +
        pct_norm(b.follower_growth_30d, 100)   * (3/8) +
        clamp(b.active_platforms / 3)          * (2/8) +
        clamp(b.engagement_rate / 0.05)        * (1/8)
    )
    wiki_score = (
        (0.3 if b.wikipedia_article_exists else 0.0) +
        log_norm(b.wikipedia_edits_7d, 50) * 0.4 +
        log_norm(b.wikipedia_inbound_links, 500) * 0.3
    )
    cultural = (
        b.tastemaker_recognition_score * (3/7) +
        b.genre_cooccurrence_score     * (2/7) +
        clamp(wiki_score)               * (2/7)
    )
    commercial = (
        clamp(b.sync_weight_90d / 4)          * (2/5) +
        log_norm(b.brand_partnerships_90d, 5) * (2/5) +
        log_norm(b.media_appearances_90d, 10) * (1/5)
    )
    base = clamp(social * 0.40 + cultural * 0.35 + commercial * 0.25)
    multiplier = round(1.0 + base * 0.10, 3)
    return base, multiplier


def score_press(p: PressSignal, stage: str) -> float:
    weighted_count = (p.tier1_count_7d * 3 + p.tier2_count_7d * 2 + p.tier3_count_7d)
    count_norm = log_norm(weighted_count, 30)
    sentiment_norm = clamp((p.press_afinn_avg + 5) / 10)
    return clamp(count_norm * 0.60 + sentiment_norm * 0.40)


def determine_stage(monthly_listeners: int) -> str:
    for stage, (lo, hi) in STAGE_THRESHOLDS.items():
        if hi is None:
            if monthly_listeners >= lo: return stage
        elif lo <= monthly_listeners < hi: return stage
    return "emerging"


def resolve_stage_with_smoothing(artist: "ArtistRecord", new_stage: str) -> tuple[str, int]:
    if new_stage == artist.career_stage: return artist.career_stage, 0
    new_buffer = artist.stage_transition_buffer + 1
    if new_buffer >= STAGE_TRANSITION_BUFFER:
        log.info(f"Stage transition: {artist.name} {artist.career_stage} ‒ {new_stage}")
        return new_stage, 0
    return artist.career_stage, new_buffer


def detect_bonuses(artist: "ArtistRecord", sub_scores: dict) -> list[dict]:
    bonuses = []
    now = datetime.now(timezone.utc)
    expires = now + timedelta(days=14)
    high_pillars = sum(1 for k, v in sub_scores.items() if v > 0.6)
    if high_pillars >= 3:
        bonuses.append({"artist_id": artist.id, "event_type": "cross_signal_spike", "event_pts": BONUS_PTS["cross_signal_spike"], "description": f"{high_pillars} pillars above 0.6", "detected_at": now.isoformat(), "expires_at": expires.isoformat(), "applied": True})
    if (artist.sentiment.mention_count_7d > CONTROVERSY_MENTION_THRESHOLD * 2
            and artist.sentiment.afinnn_avg > 1.0
            and not artist.sentiment.is_controversy):
        bonuses.append({"artist_id": artist.id, "event_type": "viral_moment", "event_pts": BONUS_PTS["viral_moment"], "description": f"Positive mention surge", "detected_at": now.isoformat(), "expires_at": expires.isoformat(), "applied": True})
    return bonuses


def get_heat_label(score: float) -> str:
    for threshold, label in HEAT_LABELS:
        if score >= threshold: return label
    return "Early signals"


def calculate_heat_score(artist: ArtistRecord) -> dict:
    raw_stage = determine_stage(artist.monthly_listeners)
    stage, buffer = resolve_stage_with_smoothing(artist, raw_stage)
    weights = STAGE_WEIGHTS[stage]
    s_stream = score_streaming(artist.streaming)
    s_sent = score_sentiment(artist.sentiment)
    s_radio = score_radio(artist.radio)
    s_brand_n, multiplier = score_brand(artist.brand)
    s_press = score_press(artist.press, stage)
    sub_scores = {"streaming": s_stream, "sentiment": s_sent, "radio": s_radio, "brand": s_brand_n, "press": s_press}
    streaming_pts = s_stream * weights["streaming"]
    brand_pts = s_brand_n * weights["brand"]
    sentiment_pts = s_sent * weights["sentiment"]
    radio_pts = s_radio * weights["radio"]
    press_pts = s_press * weights["press"]
    base_score = streaming_pts + brand_pts + sentiment_pts + radio_pts + press_pts
    bonus_events = detect_bonuses(artist, sub_scores)
    bonus_pts = min(sum(b["event_pts"] for b in bonus_events), 4.0)
    base_score += bonus_pts
    controversy_active = artist.sentiment.is_controversy
    multiplier_suppressed = controversy_active
    if multiplier_suppressed: multiplier = 1.000
    final_score = round(min(base_score * multiplier, 110.0), 2)
    return {"artist_id": artist.id, "career_stage": stage, "stage_buffer": buffer, "streaming_score": round(streaming_pts, 2), "brand_score": round(brand_pts, 2), "sentiment_score": round(sentiment_pts, 2), "radio_score": round(radio_pts, 2), "press_score": round(press_pts, 2), "bonus_pts": bonus_pts, "base_score": round(base_score, 2), "brand_multiplier": multiplier, "final_score": final_score, "heat_label": get_heat_label(final_score), "controversy_active": controversy_active, "multiplier_suppressed": multiplier_suppressed, "bonus_events": bonus_events, "sub_scores": sub_scores}


def fetch_artists(db: Client, offset: int = 0) -> list:
    rows = (db.table("artists").select("id, name, monthly_listeners, career_stage, stage_transition_buffer, controversy_flag").range(offset, offset + BATCH_SIZE - 1).execute()).data
    artists = []
    for row in rows:
        artist = ArtistRecord(id=row["id"], name=row["name"], monthly_listeners=row.get("monthly_listeners", 0) or 0, career_stage=row.get("career_stage", "emerging"), stage_transition_buffer=row.get("stage_transition_buffer", 0) or 0, controversy_flag=row.get("controversy_flag", False))
        def latest(table):
            r = (db.table(table).select("*").eq("artist_id", artist.id).order("captured_at", desc=True).limit(1).execute()).data
            return r[0] if r else {}
        ss = latest("artist_streaming_signals")
        artist.streaming = StreamingSignal(spotify_listeners=ss.get("spotify_listeners", 0) or 0, spotify_streams_7d=ss.get("spotify_streams_7d", 0) or 0, youtube_views_7d=ss.get("youtube_views_7d", 0) or 0, audiomack_plays_7d=ss.get("audiomack_plays_7d", 0) or 0, listener_delta_7d=float(ss.get("listener_delta_7d", 0) or 0), stream_delta_7d=float(ss.get("stream_delta_7d", 0) or 0), editorial_playlists=ss.get("editorial_playlists", 0) or 0, algo_playlists=ss.get("algo_playlists", 0) or 0, soundcharts_rank=ss.get("soundcharts_rank"), chart_delta_7d=ss.get("chart_delta_7d", 0) or 0)
        se = latest("artist_sentiment_signals")
        artist.sentiment = SentimentSignal(afinn_avg=float(se.get("afinn_avg", 0) or 0), afinna_sample_size=se.get("afinn_sample_size", 0) or 0, mention_count_7d=se.get("mention_count_7d", 0) or 0, valence_slope_7d=float(se.get("valence_slope_7d", 0) or 0), is_controversy=bool(se.get("is_controversy", False)))
        r = latest("artist_radio_signals")
        artist.radio = RadioSignal(indie_spins_7d=r.get("indie_spins_7d", 0) or 0, indie_stations_7d=r.get("indie_stations_7d", 0) or 0, indie_stations_new_7d=r.get("indie_stations_new_7d", 0) or 0, indie_stations_lost_7d=r.get("indie_stations_lost_7d", 0) or 0, commercial_spins_7d=r.get("commercial_spins_7d", 0) or 0, commercial_stations_7d=r.get("commercial_stations_7d", 0) or 0, format_count_7d=r.get("format_count_7d", 0) or 0)
        bs = latest("artist_brand_signals")
        artist.brand = BrandSignal(followers_total=bs.get("followers_total", 0) or 0, follower_growth_30d=float(bs.get("follower_growth_30d", 0) or 0), active_platforms=bs.get("active_platforms", 0) or 0, engagement_rate=float(bs.get("engagement_rate", 0) or 0), tastemaker_recognition_score=float(bs.get("tastemaker_recognition_score", 0) or 0), genre_cooccurrence_score=float(bs.get("genre_cooccurrence_score", 0) or 0), wikipedia_article_exists=bool(bs.get("wikipedia_article_exists", False)), wikipedia_edits_7d=bs.get("wikipedia_edits_7d", 0) or 0, wikipedia_inbound_links=bs.get("wikipedia_inbound_links", 0) or 0, sync_weight_90d=float(bs.get("sync_weight_90d", 0) or 0), brand_partnerships_90d=bs.get("brand_partnerships_90d", 0) or 0, media_appearances_90d=bs.get("media_appearances_90d", 0) or 0)
        ps = latest("artist_press_signals")
        artist.press = PressSignal(article_count_7d=ps.get("article_count_7d", 0) or 0, tier1_count_7d=ps.get("tier1_count_7d", 0) or 0, tier2_count_7d=ps.get("tier2_count_7d", 0) or 0, tier3_count_7d=ps.get("tier3_count_7d", 0) or 0, press_afinn_avg=float(ps.get("press_afinn_avg", 0) or 0))
        artists.append(artist)
    return artists


def write_score(db: Client, result: dict) -> None:
    now = datetime.now(timezone.utc).isoformat()
    db.table("artists").update({"heat_score": result["final_score"], "heat_label": result["heat_label"], "career_stage": result["career_stage"], "stage_transition_buffer": result["stage_buffer"], "controversy_flag": result["controversy_active"], "last_scored_at": now}).eq("id", result["artist_id"]).execute()
    db.table("artist_heat_history").insert({"artist_id": result["artist_id"], "scored_at": now, "career_stage": result["career_stage"], "streaming_score": result["streaming_score"], "brand_score": result["brand_score"], "sentiment_score": result["sentiment_score"], "radio_score": result["radio_score"], "press_score": result["press_score"], "bonus_pts": result["bonus_pts"], "base_score": result["base_score"], "brand_multiplier": result["brand_multiplier"], "final_score": result["final_score"], "heat_label": result["heat_label"], "controversy_active": result["controversy_active"], "multiplier_suppressed": result["multiplier_suppressed"]}).execute()
    for bonus in result.get("bonus_events", []):
        db.table("artist_bonus_events").insert(bonus).execute()


def run() -> None:
    db = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    log.info("Heat scorer starting")
    offset = 0; total_scored = 0
    while True:
        artists = fetch_artists(db, offset=offset)
        if not artists: break
        for artist in artists:
            try:
                result = calculate_heat_score(artist)
                write_score(db, result)
                log.info(f"Scored {artist.name} [{result['career_stage']}] → {result['final_score']} ({result['heat_label']})")
                total_scored += 1
            except Exception as e:
                log.error(f"Failed to score {artist.name}: {e}", exc_info=True)
        offset += BATCH_SIZE
    log.info(f"Heat scorer complete. Scored {total_scored} artists.")


if __name__ == "__main__":
    run()
