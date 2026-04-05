-- =======================================================================================
 -- TUNEDEX SCHEMA v2 ‚Äî HEAT SCORING LAYER
-- Run this after the original schema.sql migration
-- Adds: career stage system, brand signals, radio signals,
--        sentiment signals, heat score history, controversy flags
-- =======================================================================================

ALTER TABLE artists
  ADD COLUMN IF NOT EXISTS monthly_listeners        integer   DEFAULT 0,
  ADD COLUMN IF NOT EXISTS career_stage             text      DEFAULT 'emerging'
                                                     CHECK (career_stage IN ('emerging','rising','breaking','established')),
  ADD COLUMN IF NOT EXISTS s tage_transition_buffer  integer   DEFAULT 0,
  ADD COLUMN IF NOT EXRS‘T»⁄Z⁄\YXW›\õ^àQ””SSàQàì’Vîı27˜FñgïˆñBFWáB¿¢DB4Ù≈T‘‚îb‰ıBUÑï5E2ñ˜WGV&Uˆ6ÜÊÊV≈ˆñBFWáB¿¢DB4Ù≈T‘‚îb‰ıBUÖ%=ELÅçΩπ—…ΩŸï…ÕÂ}ô±ÖúÄÄÄÄÄÄÄÄÅâΩΩ±ïÖ∏ÄÄÅU1PÅôÖ±Õî∞(ÄÅÅ=1U58Å%Å9=PÅaIOQS heat_score               numeric(5,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS heat_label               text      DEFAULT 'Early signals',
  ADD COLUMN IF NOT EXISTS last_scored_at           timestamptz;

CREATE INDEX IF NOT EXISTS idx_artists_career_stage   ON artists(career_stage);
CREATE INDEX IF NOT EXISTS idx_artists_heat_score     ON artists(heat_score DESC);
CREATE TABLE IF NOT EXISTS artist_streaming_signals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id       uuid REFERENCES artists(id) ON DELETE CASCADE,
  captured_at     timestamptz NOT NULL DEFAULT now(),
  spotify_listeners   integer,
  spotify_streams_7d  integer,
  youtube_views_7d    integer,
  audiomack_plays_7d  integer,
  listener_delta_7d   numeric(6,2),
  stream_delta_7d     numeric(6,2),
  editorial_playlists integer DEFAULT 0,
  algo_playlists      integer DEFAULT 0,
  soundcharts_rank    integer,
  chart_delta_7d      integer,
  streaming_score     numeric(5,2) DEFAULT 0,
  source              text DEFAULT 'soundcharts'
);
CREATE TABLE IF NOT EXISTS artist_sentiment_signals (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id           uuid REFERENCES artists(id) ON DELETE CASCADE,
  captured_at         timestamptz NOT NULL DEFAULT now(),
  afinn_avg           numeric(4,2) DEFAULT 0,
  afinn_sample_size   integer DEFAULT 0,
  afinn_x             numeric(4,2),
  afinn_reddit        numeric(4,2),
  afinn_press_comments numeric(4,2),
  mention_count_7d    integer DEFAULT 0,
  valence_slope_7d    numeric(5,3) DEFAULT 0,
  is_controversy      boolean DEFAULT false,
  sentiment_score     numeric(5,2) DEFAULT 0
);
CREATE TABLE IF NOT EXISTS artist_radio_signals (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id             uuid REFERENCES artists(id) ON DELETE CASCADE,
  captured_at           timestamptz NOT NULL DEFAULT now(),
  indie_spins_7d        integer DEFAULT 0,
  indie_stations_7d     integer DEFAULT 0,
  indie_stations_new_7d  integer DEFAULT 0,
  indie_stations_lost_7d integer DEFAULT 0,
  commercial_spins_7d    integer DEFAULT 0,
  commercial_stations_7d integer DEFAULT 0,
  format_count_7d        integer DEFAULT 0,
  radio_score            numeric(5,2) DEFAULT 0,
  source                 text DEFAULT 'spinitron'
);
CREATE TABLE IF NOT EXISTS artist_brand_signals (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id                 uuid REFERENCES artists(id) ON DELETE CASCADE,
  captured_at               timestamptz NOT NULL DEFAULT now(),
  followers_spotify         integer DEFAULT 0,
  followers_youtube         integer DEFAULT 0,
  followers_x               integer DEFAULT 0,
  follower_growth_30d       numeric(6,2) DEFAULT 0,
  active_platforms          integer DEFAULT 0,
  engagement_rate           numeric(5,4) DEFAULT 0,
  tastemaker_recognition_score numeric(3,2) DEFAULT 0,
  genre_cooccurrence_score  numeric(3,2) DEFAULT 0,
  wikipedia_article_exists  boolean DEFAULT false,
  wikipedia_edits_7d        integer DEFAULT 0,
  wikipedia_inbound_links   integer DEFAULT 0,
  sync_weight_90d           numeric(4,1) DEFAULT 0,
  brand_partnerships_90d    integer DEFAULT 0,
  media_appearances_90d     integer DEFAULT 0,
  brand_base_score          numeric(5,2) DEFAULT 0,
  brand_multiplier          numeric(4,3) DEFAULT 1.000
);
CREATE TABLE IF NOT EXISTS artist_press_signals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id         uuid REFERENCES artists(id) ON DELETE CASCADE,
  captured_at       timestamptz NOT NULL DEFAULT now(),
  article_count_7d  integer DEFAULT 0,
  tier1_count_7d    integer DEFAULT 0,
  tier2_count_7d    integer DEFAULT 0,
  tier3_count_7d    integer DEFAULT 0,
  press_afinn_avg   numeric(4,2) DEFAULT 0,
  press_score       numeric(5,2) DEFAULT 0
);
CREATE TABLE IF NOT EXISTS artist_bonus_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id     uuid REFERENCES artists(id) ON DELETE CASCADE,
  event_type    text NOT NULL,
  event_pts     numeric(3,1) NOT NULL,
  description   text,
  detected_at   timestamptz DEFAULT now(),
  expires_at    timestamptz,
  applied       boolean DEFAULT false
);
CREATE TABLE IF NOT EXISTS artist_heat_history (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id       uuid REFERENCES artists(id) ON DELETE CASCADE,
  scored_at       timestamptz NOT NULL DEFAULT now(),
  career_stage    text NOT NULL,
  streaming_score numeric(5,2) DEFAULT 0,
  brand_score     numeric(5,2) DEFAULT 0,
  sentiment_score numeric(5,2) DEFAULT 0,
  radio_score     numeric(5,2) DEFAULT 0,
  press_score     numeric(5,2) DEFAULT 0,
  bonus_pts       numeric(4,1) DEFAULT 0,
  base_score      numeric(5,2) DEFAULT 0,
  brand_multiplier numeric(4,3) DEFAULT 1.000,
  final_score     numeric(5,2) DEFAULT 0,
  heat_label      text,
  controversy_active boolean DEFAULT false,
  multiplier_suppressed boolean DEFAULT false
);
CREATE TABLE IF NOT EXISTS stage_weight_config (
  stage               text PRIMARY KEY,
  listener_min        integer,
  listener_max        integer,
  weight_streaming    integer NOT NULL,
  weight_brand        integer NOT NULL,
  weight_sentiment    integer NOT NULL,
  weight_radio        integer NOT NULL,
  weight_press        integer NOT NULL
);
INSERT INTO stage_weight_config VALUES
('emerging',      0,       10000,  20, 14, 24, 22, 16),
('rising',        10000,  100000, 26, 18, 22, 18, 12),
('breaking',      100000, 1000000, 30, 22, 20, 14, 10),
('established',   1000000, NULL,   34, 26, 18, 10, 8)
ON CONFLICT (stage) DO UPDATE SET
  weight_streaming = EXCLUDED.weight_streaming,
  weight_brand = EXCLUDED.weight_brand,
  weight_sentiment = EXCLUDED.weight_sentiment,
  weight_radio = EXCLUDED.weight_radio,
  weight_press = EXCLUDED.weight_press;
CREATE INDEX IF NOT EXISTS idx_streaming_artist ON artist_streaming_signals(artist_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_sentiment_artist ON artist_sentiment_signals(artist_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_radio_artist ON artist_radio_signals(artist_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_brand_artist ON artist_brand_signals(artist_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_press_artist ON artist_press_signals(artist_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_heat_history_artist ON artist_heat_history(artist_id, scored_at DESC);
CREATE INDEX IF NOT EXISTS idx_heat_history_score ON artist_heat_history(final_score DESC);
CREATE TABLE IF NOT EXISTS artist_mentions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id     uuid REFERENCES artists(id) ON DELETE CASCADE,
  source        text,
  mention_type  text,
  afinn_score   numeric(4,2),
  mention_count integer DEFAULT 1,
  captured_at   timestamptz DEFAULT now()
);
ALTER TABLE artist_streaming_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE artist_sentiment_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE artist_radio_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE artist_brand_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE artist_press_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE artist_bonus_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE artist_heat_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE stage_weight_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read streaming" ON artist_streaming_signals FOR SELECT USING (true);
CREATE POLICY "public read sentiment" ON artist_sentiment_signals FOR SELECT USING (true);
CREATE POLICY "public read radio" ON artist_radio_signals FOR SELECT USING (true);
CREATE POLICY "public read brand" ON artist_brand_signals FOR SELECT USING (true);
CREATE POLICY "public read press" ON artist_press_signals FOR SELECT USING (true);
CREATE POLICY "public read bonus" ON artist_bonus_events FOR SELECT USING (true);
CREATE POLICY "public read heat" ON artist_heat_history FOR SELECT USING (true);
CREATE POLICY "public read weights" ON stage_weight_config FOR SELECT USING (true);
CREATE POLICY "service write streaming" ON artist_streaming_signals FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service write sentiment" ON artist_sentiment_signals FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service write radio" ON artist_radio_signals FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service write brand" ON artist_brand_signals FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service write press" ON artist_press_signals FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service write bonus" ON artist_bonus_events FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service write heat" ON artist_heat_history FOR ALL USING (auth.role() = 'service_role');