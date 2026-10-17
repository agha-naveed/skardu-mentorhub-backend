-- ============================================================
-- Migration v2 — the features added after the first release
-- ============================================================
-- Safe to run more than once. Every statement checks first.
--   OTP password reset · push notifications · class schedule and
--   attendance · assignments · timed exams with anti-cheat ·
--   monthly payment cycle · payment settings · read-only audit log
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ------------------------------------------------------------
-- 1. Password reset by WhatsApp OTP
-- ------------------------------------------------------------
-- The code is stored HASHED, like a password. A leaked database
-- must not hand out working codes.
--   attempts      wrong guesses so far (locked at 5)
--   used_at       set the moment the code is accepted — it works once
--   reset_hash    hash of the short-lived token handed back after a
--                 correct code; the change-password screen needs it
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS password_resets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL when the number is not registered. Those requests are still
  -- recorded so cooldowns and limits behave identically either way,
  -- which is what lets the API answer the same for both.
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  phone       VARCHAR(20) NOT NULL,
  code_hash   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  used_at     TIMESTAMPTZ,
  reset_hash  TEXT,
  reset_expires_at TIMESTAMPTZ,
  reset_used_at    TIMESTAMPTZ,
  ip          VARCHAR(64),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pwreset_phone ON password_resets(phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pwreset_ip    ON password_resets(ip, created_at DESC);

-- Tokens issued before this moment stop working, so changing a
-- password signs out every other device.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;

-- ------------------------------------------------------------
-- 2. Push notifications
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token        TEXT NOT NULL UNIQUE,
  platform     VARCHAR(20) NOT NULL DEFAULT 'android',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id);

-- One row per person, created on first use. A missing row means
-- "everything on".
CREATE TABLE IF NOT EXISTS notification_prefs (
  user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  messages      BOOLEAN NOT NULL DEFAULT true,
  classes       BOOLEAN NOT NULL DEFAULT true,
  assignments   BOOLEAN NOT NULL DEFAULT true,
  exams         BOOLEAN NOT NULL DEFAULT true,
  announcements BOOLEAN NOT NULL DEFAULT true,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Where tapping a notification should take the person.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS data JSONB;

-- ------------------------------------------------------------
-- 3. Chat: images and receipts
-- ------------------------------------------------------------
ALTER TABLE messages ADD COLUMN IF NOT EXISTS image_url    TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

-- ------------------------------------------------------------
-- 4. Class schedule and attendance
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS class_sessions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tutor_id         UUID    NOT NULL REFERENCES tutors(id)   ON DELETE CASCADE,
  subject_id       INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  title            VARCHAR(160) NOT NULL,
  starts_at        TIMESTAMPTZ NOT NULL,
  ends_at          TIMESTAMPTZ NOT NULL,
  mode             VARCHAR(20) NOT NULL DEFAULT 'centre'
                   CHECK (mode IN ('centre', 'student_home', 'online')),
  location         TEXT,
  meeting_link     TEXT,
  status           VARCHAR(20) NOT NULL DEFAULT 'scheduled'
                   CHECK (status IN ('scheduled', 'cancelled')),
  cancel_reason    TEXT,
  reminder_sent_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_sessions_tutor ON class_sessions(tutor_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_sessions_due   ON class_sessions(starts_at)
  WHERE status = 'scheduled' AND reminder_sent_at IS NULL;

CREATE TABLE IF NOT EXISTS class_session_students (
  session_id UUID NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES users(id)          ON DELETE CASCADE,
  PRIMARY KEY (session_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_session_students_student ON class_session_students(student_id);

CREATE TABLE IF NOT EXISTS attendance (
  session_id   UUID NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
  student_id   UUID NOT NULL REFERENCES users(id)          ON DELETE CASCADE,
  check_in_at  TIMESTAMPTZ NOT NULL,
  check_out_at TIMESTAMPTZ,
  marked_by    VARCHAR(10) NOT NULL DEFAULT 'student'
               CHECK (marked_by IN ('student', 'tutor')),
  PRIMARY KEY (session_id, student_id),
  CHECK (check_out_at IS NULL OR check_out_at >= check_in_at)
);

-- ------------------------------------------------------------
-- 5. Assignments
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assignments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tutor_id        UUID    NOT NULL REFERENCES tutors(id)   ON DELETE CASCADE,
  subject_id      INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  title           VARCHAR(160) NOT NULL,
  description     TEXT,
  attachment_url  TEXT,
  attachment_name VARCHAR(160),
  due_at          TIMESTAMPTZ NOT NULL,
  max_marks       INTEGER NOT NULL DEFAULT 100 CHECK (max_marks BETWEEN 1 AND 1000),
  allow_late      BOOLEAN NOT NULL DEFAULT false,
  reminder_sent_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_assignments_tutor ON assignments(tutor_id, due_at DESC);

CREATE TABLE IF NOT EXISTS assignment_students (
  assignment_id UUID NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  student_id    UUID NOT NULL REFERENCES users(id)       ON DELETE CASCADE,
  PRIMARY KEY (assignment_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_assignment_students_student ON assignment_students(student_id);

CREATE TABLE IF NOT EXISTS assignment_submissions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id UUID NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  student_id    UUID NOT NULL REFERENCES users(id)       ON DELETE CASCADE,
  answer_text   TEXT,
  file_url      TEXT,
  file_name     VARCHAR(160),
  submitted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_late       BOOLEAN NOT NULL DEFAULT false,
  marks         INTEGER,
  feedback      TEXT,
  marked_at     TIMESTAMPTZ,
  UNIQUE (assignment_id, student_id)
);

-- ------------------------------------------------------------
-- 6. Exams: 15 seconds a question, enforced by the server
-- ------------------------------------------------------------
ALTER TABLE quizzes        ADD COLUMN IF NOT EXISTS seconds_per_question INTEGER NOT NULL DEFAULT 15;
ALTER TABLE quiz_attempts  ADD COLUMN IF NOT EXISTS current_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE quiz_attempts  ADD COLUMN IF NOT EXISTS question_started_at TIMESTAMPTZ;
ALTER TABLE quiz_attempts  ADD COLUMN IF NOT EXISTS cheat_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE quiz_answers   ADD COLUMN IF NOT EXISTS cheated   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE quiz_answers   ADD COLUMN IF NOT EXISTS timed_out BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE quiz_answers   ADD COLUMN IF NOT EXISTS answered_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS exam_cheat_events (
  id          BIGSERIAL PRIMARY KEY,
  attempt_id  UUID NOT NULL REFERENCES quiz_attempts(id)  ON DELETE CASCADE,
  quiz_id     UUID NOT NULL REFERENCES quizzes(id)        ON DELETE CASCADE,
  student_id  UUID NOT NULL REFERENCES users(id)          ON DELETE CASCADE,
  question_id UUID REFERENCES quiz_questions(id)          ON DELETE SET NULL,
  kind        VARCHAR(20) NOT NULL
              CHECK (kind IN ('back_button', 'app_switch', 'screen_leave')),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cheat_attempt ON exam_cheat_events(attempt_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_cheat_quiz    ON exam_cheat_events(quiz_id, occurred_at DESC);

-- ------------------------------------------------------------
-- 7. Monthly payment cycle and admin-editable payment details
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_settings (
  key        VARCHAR(60) PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO app_settings (key, value) VALUES (
  'payment_details',
  '{
    "account_title": "Smart Tutor Finder",
    "account_number": "0000-0000000-0",
    "bank_name": "Meezan Bank",
    "iban": "",
    "methods": [
      {"name": "Easypaisa", "number": "0300-0000000"},
      {"name": "JazzCash",  "number": "0300-0000000"},
      {"name": "Bank transfer", "number": "0000-0000000-0"}
    ],
    "monthly_fee": 1000,
    "due_day": 3,
    "instructions": "Pay the monthly fee using any method above, then upload your receipt here. Payment is due by the 3rd of every month."
  }'::jsonb
) ON CONFLICT (key) DO NOTHING;

ALTER TABLE payments ADD COLUMN IF NOT EXISTS for_month DATE;
ALTER TABLE tutors   ADD COLUMN IF NOT EXISTS payment_suspended BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tutors   ADD COLUMN IF NOT EXISTS payment_suspended_at TIMESTAMPTZ;
ALTER TABLE tutors   ADD COLUMN IF NOT EXISTS last_reminder_on DATE;
CREATE INDEX IF NOT EXISTS idx_payments_month ON payments(for_month, status);

-- ------------------------------------------------------------
-- 8. The audit log cannot be edited or deleted
-- ------------------------------------------------------------
-- Enforced in the database, not just the API, so nobody with a
-- stray SQL console (or a future bug) can quietly rewrite history.
--
-- The one allowed change: when a USER is deleted the foreign key
-- sets user_id to NULL. The entry keeps its copied name and role,
-- so it still reads sensibly.
-- ------------------------------------------------------------
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS ip VARCHAR(64);
ALTER TABLE activity_log ALTER COLUMN action TYPE VARCHAR(60);
CREATE INDEX IF NOT EXISTS idx_activity_role ON activity_log(user_role, created_at DESC);

CREATE OR REPLACE FUNCTION activity_log_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.user_id IS NULL
     AND NEW.id          IS NOT DISTINCT FROM OLD.id
     AND NEW.user_name   IS NOT DISTINCT FROM OLD.user_name
     AND NEW.user_role   IS NOT DISTINCT FROM OLD.user_role
     AND NEW.action      IS NOT DISTINCT FROM OLD.action
     AND NEW.detail      IS NOT DISTINCT FROM OLD.detail
     AND NEW.created_at  IS NOT DISTINCT FROM OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'The audit log is read-only: entries cannot be edited or deleted.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_activity_log_guard ON activity_log;
CREATE TRIGGER trg_activity_log_guard
  BEFORE UPDATE OR DELETE ON activity_log
  FOR EACH ROW EXECUTE FUNCTION activity_log_guard();

-- Tutors approved before the monthly cycle existed have no covered
-- month. Cover the rest of the current month so nobody is suspended
-- by surprise the first time the scheduler runs.
UPDATE tutors
   SET subscription_paid_until = (date_trunc('month', now() AT TIME ZONE 'Asia/Karachi')
                                  + interval '1 month - 1 day')::date
 WHERE verification_status = 'verified' AND subscription_paid_until IS NULL;
