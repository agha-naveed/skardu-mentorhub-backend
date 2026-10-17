-- ============================================================
-- Catching an older database up
-- ============================================================
-- Run this instead of db:setup when you already have data you
-- want to keep. db:setup DROPS every table and starts again;
-- this adds only what is missing.
--
-- Safe to run more than once. Every statement checks first, so
-- running it twice changes nothing the second time.
--
--   cd server
--   node migrate.js
--
-- ============================================================

-- gen_random_uuid() is needed by every table below. An older
-- database may not have had the extension enabled.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ------------------------------------------------------------
-- 1. users
-- ------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at     TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar            VARCHAR(120);
ALTER TABLE users ADD COLUMN IF NOT EXISTS learning_modes    TEXT[] NOT NULL DEFAULT '{}';

-- An older build stored a push token. Nothing uses it now — the
-- app polls and uses local notifications instead — so it goes.
ALTER TABLE users DROP COLUMN IF EXISTS push_token;
ALTER TABLE users DROP COLUMN IF EXISTS push_platform;

-- Existing students had no learning modes, which would leave them
-- matching no tutor at all. The centre is the safe assumption:
-- it is how tuition in Skardu mostly works, and they can tick
-- more whenever they like.
UPDATE users
   SET learning_modes = '{centre}'
 WHERE role = 'student'
   AND (learning_modes IS NULL OR cardinality(learning_modes) = 0);

-- ------------------------------------------------------------
-- 2. tutors
-- ------------------------------------------------------------
ALTER TABLE tutors ADD COLUMN IF NOT EXISTS cnic_front              VARCHAR(120);
ALTER TABLE tutors ADD COLUMN IF NOT EXISTS cnic_back               VARCHAR(120);
ALTER TABLE tutors ADD COLUMN IF NOT EXISTS qualification_doc       VARCHAR(120);
ALTER TABLE tutors ADD COLUMN IF NOT EXISTS qualification_verified  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tutors ADD COLUMN IF NOT EXISTS qualification_note      TEXT;
ALTER TABLE tutors ADD COLUMN IF NOT EXISTS terms_accepted_at       TIMESTAMPTZ;
ALTER TABLE tutors ADD COLUMN IF NOT EXISTS pending_changes         JSONB;
ALTER TABLE tutors ADD COLUMN IF NOT EXISTS pending_changes_at      TIMESTAMPTZ;
ALTER TABLE tutors ADD COLUMN IF NOT EXISTS subscription_paid_until DATE;
ALTER TABLE tutors ADD COLUMN IF NOT EXISTS listed                  BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE tutors ADD COLUMN IF NOT EXISTS suspended_until         DATE;
ALTER TABLE tutors ADD COLUMN IF NOT EXISTS teaching_modes          TEXT[] NOT NULL DEFAULT '{centre}';

-- An older build had ONE teaching_mode. Carry whatever each tutor
-- chose into the new array before the old column goes, so nobody
-- silently becomes centre-only.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'tutors' AND column_name = 'teaching_mode'
  ) THEN
    UPDATE tutors
       SET teaching_modes = CASE
             -- 'any' used to mean all three.
             WHEN teaching_mode = 'any' THEN ARRAY['centre', 'student_home', 'online']
             WHEN teaching_mode IS NULL THEN ARRAY['centre']
             ELSE ARRAY[teaching_mode]
           END
     WHERE cardinality(teaching_modes) = 0
        OR teaching_modes = ARRAY['centre'];

    ALTER TABLE tutors DROP COLUMN teaching_mode;
  END IF;
END $$;

-- Also from an older build, replaced by pending_changes.
ALTER TABLE tutors DROP COLUMN IF EXISTS subjects_changed_at;
ALTER TABLE tutors DROP COLUMN IF EXISTS subjects_change_note;

-- ------------------------------------------------------------
-- 3. enrollments — the column in the error
-- ------------------------------------------------------------
ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS completed_at  TIMESTAMPTZ;
ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS left_at       TIMESTAMPTZ;
ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS left_reason   TEXT;
ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS learning_mode VARCHAR(20) NOT NULL DEFAULT 'centre';

-- The CHECK has to be rebuilt, because the old one does not know
-- about 'left' and would reject a student leaving.
DO $$
BEGIN
  ALTER TABLE enrollments DROP CONSTRAINT IF EXISTS enrollments_status_check;
  ALTER TABLE enrollments DROP CONSTRAINT IF EXISTS enrollments_learning_mode_check;
EXCEPTION WHEN undefined_object THEN
  NULL;
END $$;

ALTER TABLE enrollments
  ADD CONSTRAINT enrollments_status_check
  CHECK (status IN ('pending', 'accepted', 'rejected',
                    'cancelled', 'completed', 'left'));

ALTER TABLE enrollments
  ADD CONSTRAINT enrollments_learning_mode_check
  CHECK (learning_mode IN ('centre', 'student_home', 'online'));

-- ------------------------------------------------------------
-- 4. enrollment_subjects
-- ------------------------------------------------------------
-- One request can cover several subjects. An older build had one
-- subject per enrollment row instead.
CREATE TABLE IF NOT EXISTS enrollment_subjects (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id UUID    NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  subject_id    INTEGER NOT NULL REFERENCES subjects(id)    ON DELETE CASCADE,
  monthly_fee   INTEGER NOT NULL DEFAULT 0,
  UNIQUE (enrollment_id, subject_id)
);

CREATE INDEX IF NOT EXISTS idx_enrollment_subjects ON enrollment_subjects(enrollment_id);

-- Move the old single subject across, then drop the column.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'enrollments' AND column_name = 'subject_id'
  ) THEN
    INSERT INTO enrollment_subjects (enrollment_id, subject_id, monthly_fee)
    SELECT e.id, e.subject_id, COALESCE(ts.monthly_fee, 0)
      FROM enrollments e
      LEFT JOIN tutor_subjects ts
             ON ts.tutor_id = e.tutor_id AND ts.subject_id = e.subject_id
     WHERE e.subject_id IS NOT NULL
    ON CONFLICT DO NOTHING;

    ALTER TABLE enrollments DROP COLUMN subject_id;
  END IF;
END $$;

-- One LIVE request per student and tutor, not per subject.
DROP INDEX IF EXISTS idx_enrollments_open;

CREATE UNIQUE INDEX IF NOT EXISTS idx_enrollments_open
  ON enrollments(student_id, tutor_id)
  WHERE status IN ('pending', 'accepted');

-- ------------------------------------------------------------
-- 5. reviews and reports
-- ------------------------------------------------------------
-- Created first, in case this database is old enough not to have
-- it. Altering a table that does not exist is a hard failure, and
-- the whole migration would roll back on it.
CREATE TABLE IF NOT EXISTS reviews (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tutor_id      UUID NOT NULL REFERENCES tutors(id) ON DELETE CASCADE,
  student_id    UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  enrollment_id UUID REFERENCES enrollments(id) ON DELETE SET NULL,
  rating        INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tutor_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_reviews_tutor ON reviews(tutor_id, created_at DESC);

ALTER TABLE reviews ADD COLUMN IF NOT EXISTS enrollment_id UUID REFERENCES enrollments(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS reports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id   UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  tutor_id      UUID NOT NULL REFERENCES tutors(id) ON DELETE CASCADE,
  enrollment_id UUID REFERENCES enrollments(id) ON DELETE SET NULL,
  reason        VARCHAR(60) NOT NULL,
  details       TEXT,
  status        VARCHAR(20) NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'reviewed', 'dismissed')),
  admin_note    TEXT,
  handled_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  handled_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE reports ADD COLUMN IF NOT EXISTS enrollment_id UUID REFERENCES enrollments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_tutor  ON reports(tutor_id);

-- ------------------------------------------------------------
-- 6. activity log
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  user_name   VARCHAR(120),
  user_role   VARCHAR(20),
  action      VARCHAR(40) NOT NULL,
  detail      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_activity_time   ON activity_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_user   ON activity_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_action ON activity_log(action, created_at DESC);

-- ------------------------------------------------------------
-- 7. payments
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tutor_id      UUID NOT NULL REFERENCES tutors(id) ON DELETE CASCADE,
  amount        INTEGER,
  method        VARCHAR(40),
  reference     VARCHAR(80),
  note          TEXT,
  receipt       VARCHAR(120),
  status        VARCHAR(20) NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'confirmed', 'rejected')),
  admin_note    TEXT,
  handled_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  handled_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_tutor  ON payments(tutor_id, created_at DESC);

-- ------------------------------------------------------------
-- 8. videos
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS videos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tutor_id      UUID    NOT NULL REFERENCES tutors(id)   ON DELETE CASCADE,
  subject_id    INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  title         VARCHAR(160) NOT NULL,
  description   TEXT,
  url           TEXT NOT NULL,
  source        VARCHAR(20) NOT NULL DEFAULT 'link',
  cloud_id      TEXT,
  thumbnail     TEXT,
  size_bytes    BIGINT,
  class_from    INTEGER NOT NULL DEFAULT 1,
  class_to      INTEGER NOT NULL DEFAULT 12,
  duration_mins INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- For a videos table that already existed without them.
ALTER TABLE videos ADD COLUMN IF NOT EXISTS source     VARCHAR(20) NOT NULL DEFAULT 'link';
ALTER TABLE videos ADD COLUMN IF NOT EXISTS cloud_id   TEXT;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS thumbnail  TEXT;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS size_bytes BIGINT;

DO $$
BEGIN
  ALTER TABLE videos DROP CONSTRAINT IF EXISTS videos_source_check;
EXCEPTION WHEN undefined_object THEN
  NULL;
END $$;

ALTER TABLE videos
  ADD CONSTRAINT videos_source_check CHECK (source IN ('link', 'cloudinary'));

CREATE INDEX IF NOT EXISTS idx_videos_tutor ON videos(tutor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS video_releases (
  video_id    UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  student_id  UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  release_on  DATE NOT NULL DEFAULT CURRENT_DATE,
  watched_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (video_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_releases_student ON video_releases(student_id, release_on);

-- How long, and how often — added later. The video plays outside
-- this server (YouTube/Drive/Cloudinary), so there is no player
-- here to report exact position; the app instead adds up real
-- seconds while the lesson is open, in short heartbeats.
ALTER TABLE video_releases ADD COLUMN IF NOT EXISTS watched_seconds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE video_releases ADD COLUMN IF NOT EXISTS watch_count     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE video_releases ADD COLUMN IF NOT EXISTS last_watched_at TIMESTAMPTZ;

-- ------------------------------------------------------------
-- 8b. quizzes
-- ------------------------------------------------------------
-- An online quiz a tutor sets for their students — class-wise, or
-- for anybody else they choose. Shared the same way videos are:
-- explicitly released to named students from a named date.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS quizzes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tutor_id        UUID    NOT NULL REFERENCES tutors(id)   ON DELETE CASCADE,
  subject_id      INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  title           VARCHAR(160) NOT NULL,
  description     TEXT,
  class_from      INTEGER NOT NULL DEFAULT 1,
  class_to        INTEGER NOT NULL DEFAULT 12,
  time_limit_mins INTEGER,
  is_published    BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quizzes_tutor ON quizzes(tutor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS quiz_questions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_id       UUID NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  question_text TEXT NOT NULL,
  order_index   INTEGER NOT NULL DEFAULT 0,
  points        INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_quiz_questions_quiz ON quiz_questions(quiz_id, order_index);

CREATE TABLE IF NOT EXISTS quiz_options (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id UUID NOT NULL REFERENCES quiz_questions(id) ON DELETE CASCADE,
  option_text TEXT NOT NULL,
  is_correct  BOOLEAN NOT NULL DEFAULT false,
  order_index INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_quiz_options_question ON quiz_options(question_id, order_index);

CREATE TABLE IF NOT EXISTS quiz_releases (
  quiz_id     UUID NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  student_id  UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  release_on  DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (quiz_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_quiz_releases_student ON quiz_releases(student_id, release_on);

CREATE TABLE IF NOT EXISTS quiz_attempts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_id      UUID NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  student_id   UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at TIMESTAMPTZ,
  score        INTEGER,
  max_score    INTEGER,
  UNIQUE (quiz_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_quiz_attempts_quiz    ON quiz_attempts(quiz_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_student ON quiz_attempts(student_id);

CREATE TABLE IF NOT EXISTS quiz_answers (
  attempt_id  UUID NOT NULL REFERENCES quiz_attempts(id)  ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES quiz_questions(id) ON DELETE CASCADE,
  option_id   UUID REFERENCES quiz_options(id) ON DELETE SET NULL,
  is_correct  BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (attempt_id, question_id)
);

-- ------------------------------------------------------------
-- 9. chat and announcements
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tutor_id     UUID NOT NULL REFERENCES tutors(id) ON DELETE CASCADE,
  student_id   UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  sender       VARCHAR(10) NOT NULL CHECK (sender IN ('tutor', 'student')),
  body         TEXT NOT NULL,
  read_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(tutor_id, student_id, created_at);

CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(student_id, read_at)
  WHERE read_at IS NULL;

CREATE TABLE IF NOT EXISTS announcements (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tutor_id    UUID NOT NULL REFERENCES tutors(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_announcements_tutor ON announcements(tutor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS announcement_reads (
  announcement_id UUID NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  student_id      UUID NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
  read_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (announcement_id, student_id)
);

-- ------------------------------------------------------------
-- 10. notifications
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        VARCHAR(40) NOT NULL,
  title       VARCHAR(160) NOT NULL,
  message     TEXT,
  is_read     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user
  ON notifications(user_id, is_read, created_at DESC);
