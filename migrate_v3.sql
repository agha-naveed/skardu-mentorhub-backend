-- ============================================================
-- Migration v3
-- ============================================================
--   · academic field (Engineering / Medical / Computer Science)
--     for classes 9, 10, 1st year (11) and 2nd year (12)
--   · coverage areas drawn on a map
--   · per-sitting video watch history
-- Safe to run more than once.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Academic field
-- ------------------------------------------------------------
-- A student's field. Only meaningful for classes 9-12; the API keeps
-- it empty for anybody else.
ALTER TABLE users ADD COLUMN IF NOT EXISTS academic_field VARCHAR(20);

-- Which fields a tutor teaches a subject for. NULL means "all of
-- them", so every tutor that existed before this column keeps working.
ALTER TABLE tutor_subjects ADD COLUMN IF NOT EXISTS fields TEXT[];

-- A video can be for one field only (NULL = everybody).
ALTER TABLE videos ADD COLUMN IF NOT EXISTS academic_field VARCHAR(20);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_academic_field_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_academic_field_check
      CHECK (academic_field IS NULL OR academic_field IN ('engineering', 'medical', 'computer_science'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'videos_academic_field_check') THEN
    ALTER TABLE videos ADD CONSTRAINT videos_academic_field_check
      CHECK (academic_field IS NULL OR academic_field IN ('engineering', 'medical', 'computer_science'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tutor_subjects_fields_check') THEN
    ALTER TABLE tutor_subjects ADD CONSTRAINT tutor_subjects_fields_check
      CHECK (fields IS NULL OR fields <@ ARRAY['engineering', 'medical', 'computer_science']::text[]);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_users_field ON users(academic_field) WHERE academic_field IS NOT NULL;

-- ------------------------------------------------------------
-- 2. Coverage areas
-- ------------------------------------------------------------
-- A named area drawn on the map. `polygon` is a list of [lat, lng]
-- corners, in order. A tutor is "in" an area when their pinned
-- location falls inside it.
CREATE TABLE IF NOT EXISTS coverage_areas (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       VARCHAR(80) NOT NULL,
  polygon    JSONB NOT NULL,
  center_lat NUMERIC(9,6) NOT NULL,
  center_lng NUMERIC(9,6) NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_coverage_areas_name ON coverage_areas (lower(name));

-- Ray casting: is the point inside the polygon? Done in the database so
-- a search can filter and sort in a single query.
CREATE OR REPLACE FUNCTION point_in_polygon(plat double precision, plng double precision, poly jsonb)
RETURNS boolean AS $$
DECLARE
  n int; i int; j int;
  inside boolean := false;
  yi double precision; xi double precision; yj double precision; xj double precision;
BEGIN
  IF plat IS NULL OR plng IS NULL OR poly IS NULL OR jsonb_typeof(poly) <> 'array' THEN RETURN false; END IF;
  n := jsonb_array_length(poly);
  IF n < 3 THEN RETURN false; END IF;
  j := n - 1;
  FOR i IN 0..n - 1 LOOP
    yi := (poly -> i ->> 0)::double precision;  xi := (poly -> i ->> 1)::double precision;
    yj := (poly -> j ->> 0)::double precision;  xj := (poly -> j ->> 1)::double precision;
    -- the edge crosses the point's latitude...
    IF (yi > plat) <> (yj > plat) THEN
      -- ...and the crossing lies east of the point
      IF plng < (xj - xi) * (plat - yi) / (yj - yi) + xi THEN
        inside := NOT inside;
      END IF;
    END IF;
    j := i;
  END LOOP;
  RETURN inside;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Feature switch for the area filter, so it can be hidden without
-- deleting anything. On by default.
INSERT INTO app_settings (key, value)
VALUES ('features', '{"coverage_areas": true}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ------------------------------------------------------------
-- 3. Video watch history
-- ------------------------------------------------------------
-- One row per SITTING: when it started, how many seconds were actually
-- playing, and how far into the video the student got.
CREATE TABLE IF NOT EXISTS video_watch_sessions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id             UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  student_id           UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  started_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  seconds              INTEGER NOT NULL DEFAULT 0,
  max_position_seconds INTEGER NOT NULL DEFAULT 0,
  completed            BOOLEAN NOT NULL DEFAULT false,
  -- 'playing' = the video really played; 'open' = the page was open
  -- (links that cannot report playback, like a Drive folder).
  method               VARCHAR(10) NOT NULL DEFAULT 'playing' CHECK (method IN ('playing', 'open'))
);
CREATE INDEX IF NOT EXISTS idx_watch_sessions_video   ON video_watch_sessions(video_id, student_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_watch_sessions_student ON video_watch_sessions(student_id, started_at DESC);

-- The player reports the real length, which beats the tutor's guess.
ALTER TABLE videos ADD COLUMN IF NOT EXISTS duration_seconds INTEGER;
