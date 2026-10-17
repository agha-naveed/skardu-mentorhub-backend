-- ============================================================
-- Smart Tutor Finder — database
-- ============================================================
-- Run once with:  npm run db:setup
--
-- Tables are dropped in reverse dependency order and created in
-- forward order, because a table cannot reference one that does
-- not exist yet. reviews points at enrollments, so enrollments is
-- created first.
-- ============================================================

DROP TABLE IF EXISTS quiz_answers CASCADE;
DROP TABLE IF EXISTS quiz_attempts CASCADE;
DROP TABLE IF EXISTS quiz_releases CASCADE;
DROP TABLE IF EXISTS quiz_options CASCADE;
DROP TABLE IF EXISTS quiz_questions CASCADE;
DROP TABLE IF EXISTS quizzes CASCADE;
DROP TABLE IF EXISTS video_releases CASCADE;
DROP TABLE IF EXISTS videos CASCADE;
DROP TABLE IF EXISTS payments CASCADE;
DROP TABLE IF EXISTS announcement_reads CASCADE;
DROP TABLE IF EXISTS announcements CASCADE;
DROP TABLE IF EXISTS messages CASCADE;
DROP TABLE IF EXISTS notifications CASCADE;
DROP TABLE IF EXISTS reports CASCADE;
DROP TABLE IF EXISTS reviews CASCADE;
DROP TABLE IF EXISTS enrollment_subjects CASCADE;
DROP TABLE IF EXISTS enrollments CASCADE;
DROP TABLE IF EXISTS activity_log CASCADE;
DROP TABLE IF EXISTS tutor_availability CASCADE;
DROP TABLE IF EXISTS tutor_subjects CASCADE;
DROP TABLE IF EXISTS subjects CASCADE;
DROP TABLE IF EXISTS tutors CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- Gives us gen_random_uuid() for the id columns.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ------------------------------------------------------------
-- 1. users — one row per login, whatever the role
-- ------------------------------------------------------------
CREATE TABLE users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role              VARCHAR(20)  NOT NULL CHECK (role IN ('student', 'tutor', 'admin')),

  full_name         VARCHAR(120) NOT NULL,
  email             VARCHAR(120) NOT NULL UNIQUE,
  phone             VARCHAR(20)  NOT NULL UNIQUE,
  password          TEXT         NOT NULL,

  class_level       INTEGER,

  -- How a student is willing to be taught. An ARRAY because most
  -- people accept more than one — "online or at my home" is the
  -- normal answer, and forcing a single choice would make the
  -- filter lie.
  --
  -- Only students with 'online' in here can be sent videos.
  learning_modes    TEXT[] NOT NULL DEFAULT '{}',

  -- Profile picture. Optional for everybody — plenty of people
  -- would rather not, and demanding one would keep them out. Just
  -- the filename; the image lives in uploads/avatars.
  avatar            VARCHAR(120),

  -- Everybody accepts terms at registration. Stored as a time
  -- rather than a boolean, so there is a record of WHEN.
  terms_accepted_at TIMESTAMPTZ,

  -- Updated on every sign-in, so an admin can see who has been
  -- active and who has gone quiet.
  last_login_at     TIMESTAMPTZ,

  account_status    VARCHAR(20)  NOT NULL DEFAULT 'active'
                    CHECK (account_status IN ('active', 'suspended')),

  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_role ON users(role);

-- ------------------------------------------------------------
-- 2. tutors — the teaching profile
-- ------------------------------------------------------------
CREATE TABLE tutors (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,

  centre_name            VARCHAR(150),
  qualification          VARCHAR(200),
  experience_years       INTEGER DEFAULT 0,
  gender                 VARCHAR(10),
  bio                    TEXT,
  -- How they are willing to teach. An ARRAY, matching the
  -- students' learning_modes, because most tutors do more than one
  -- — "at my centre, and online for the ones who cannot travel" is
  -- the normal answer.
  --
  -- A single column with an 'any' value could not express "centre
  -- and online, but I will not come to your house", which is a
  -- distinction that matters to both sides.
  --
  -- 'online' in here is what unlocks the video section.
  teaching_modes         TEXT[] NOT NULL DEFAULT '{centre}',

  -- Where they teach. Shown on the profile, and used for the
  -- optional distance filter when a student shares their position.
  address                TEXT,
  latitude               DECIMAL(10, 8),
  longitude              DECIMAL(11, 8),

  -- CNIC is REQUIRED. Without it an admin cannot confirm the tutor
  -- is who they claim to be, and approval would mean nothing.
  cnic_front             VARCHAR(120),
  cnic_back              VARCHAR(120),

  -- A degree or certificate. OPTIONAL — plenty of capable tutors
  -- have no paperwork to hand, and demanding it would shut them
  -- out. Uploading one and having an admin approve it earns a
  -- badge on the profile, so it is worth doing but never required.
  qualification_doc      VARCHAR(120),
  qualification_verified BOOLEAN NOT NULL DEFAULT false,
  qualification_note     TEXT,

  terms_accepted_at      TIMESTAMPTZ,

  -- ---- changes waiting for an admin ----
  -- When an approved tutor edits their profile, the change is held
  -- HERE rather than applied. The live profile keeps working while
  -- an admin looks, and they can accept or reject it.
  --
  -- Held as JSON because the shape varies — sometimes it is three
  -- subjects, sometimes a new fee and a new bio. A column per
  -- field would mean a migration every time the form changes.
  pending_changes        JSONB,
  pending_changes_at     TIMESTAMPTZ,

  -- ---- subscription ----
  -- What keeps a tutor in search results. Paid to the admin by
  -- hand; there is no payment gateway.
  --
  -- After paid_until passes, the tutor gets GRACE_DAYS to settle
  -- up. The app counts "day 3 of 7" from this date. Past that they
  -- are withdrawn from search — they can still sign in, and
  -- everything comes back the moment they pay.
  subscription_paid_until DATE,

  -- Set once the grace period runs out, so search can exclude them
  -- with a plain check instead of date arithmetic on every query.
  listed                 BOOLEAN NOT NULL DEFAULT true,

  -- When the grace period ends with no payment even CLAIMED, the
  -- account is suspended for three days and an administrator picks
  -- it up. Sending a receipt stops this — the point is to catch
  -- silence, not lateness.
  suspended_until        DATE,

  -- pending  = waiting for an admin, invisible to students
  -- verified = approved, appears in search
  -- rejected = told why, can fix and submit again
  verification_status    VARCHAR(20) NOT NULL DEFAULT 'pending'
                         CHECK (verification_status IN ('pending', 'verified', 'rejected')),
  reject_reason          TEXT,
  reviewed_at            TIMESTAMPTZ,
  reviewed_by            UUID REFERENCES users(id) ON DELETE SET NULL,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tutors_status ON tutors(verification_status);

-- ------------------------------------------------------------
-- 3. subjects
-- ------------------------------------------------------------
-- The list grows on its own: a tutor who teaches something missing
-- types it during registration and it is added for everyone.
-- ------------------------------------------------------------
CREATE TABLE subjects (
  id            SERIAL PRIMARY KEY,
  subject_name  VARCHAR(80) NOT NULL UNIQUE
);

-- ------------------------------------------------------------
-- 4. tutor_subjects
-- ------------------------------------------------------------
-- One row per subject a tutor teaches. The FEE lives here rather
-- than on the tutor, because Class 12 Physics is not the same job
-- as Class 6 Urdu and most tutors price them differently.
-- ------------------------------------------------------------
CREATE TABLE tutor_subjects (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tutor_id      UUID    NOT NULL REFERENCES tutors(id)   ON DELETE CASCADE,
  subject_id    INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,

  class_from    INTEGER NOT NULL DEFAULT 1,
  class_to      INTEGER NOT NULL DEFAULT 12,
  monthly_fee   INTEGER NOT NULL DEFAULT 0,

  UNIQUE (tutor_id, subject_id)
);

CREATE INDEX idx_ts_subject ON tutor_subjects(subject_id);

-- ------------------------------------------------------------
-- 5. tutor_availability
-- ------------------------------------------------------------
-- One row per day the tutor teaches, EACH WITH ITS OWN TIMES. A
-- tutor working Monday 16:00-19:00 and Saturday 10:00-13:00 has
-- two rows with different hours — the days are never assumed to
-- match each other.
-- ------------------------------------------------------------
CREATE TABLE tutor_availability (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tutor_id     UUID    NOT NULL REFERENCES tutors(id) ON DELETE CASCADE,
  day_of_week  INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),  -- 0 = Sunday
  start_time   TIME    NOT NULL,
  end_time     TIME    NOT NULL,

  CHECK (end_time > start_time),
  UNIQUE (tutor_id, day_of_week)
);

-- ------------------------------------------------------------
-- 6. activity_log
-- ------------------------------------------------------------
-- What people actually did. user_id is ON DELETE SET NULL rather
-- than CASCADE on purpose: deleting an account should not erase
-- the history of what it did, so the name is kept alongside.
-- ------------------------------------------------------------
CREATE TABLE activity_log (
  id          BIGSERIAL PRIMARY KEY,

  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  user_name   VARCHAR(120),
  user_role   VARCHAR(20),

  action      VARCHAR(40) NOT NULL,
  detail      TEXT,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_activity_time   ON activity_log(created_at DESC);
CREATE INDEX idx_activity_user   ON activity_log(user_id, created_at DESC);
CREATE INDEX idx_activity_action ON activity_log(action, created_at DESC);

-- ------------------------------------------------------------
-- 7. enrollments
-- ------------------------------------------------------------
-- A student asking a tutor to take them on, for one subject.
-- This is what unlocks the tutor's phone number.
-- ------------------------------------------------------------
-- One REQUEST, however many subjects it covers. Previously each
-- subject was its own row, which meant a student asking about
-- three subjects sent three notifications and the tutor had to
-- answer three times about the same person. Now the subjects hang
-- off the request in enrollment_subjects below.
CREATE TABLE enrollments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  student_id    UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  tutor_id      UUID NOT NULL REFERENCES tutors(id) ON DELETE CASCADE,

  message       TEXT,

  -- pending   = waiting on the tutor
  -- accepted  = the tutor said yes; contact details unlocked
  -- rejected  = the tutor said no, with a note
  -- cancelled = the student withdrew before an answer
  -- completed = the tuition has finished; a review is now possible
  status        VARCHAR(20) NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled', 'completed')),

  tutor_note    TEXT,
  responded_at  TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_enrollments_student ON enrollments(student_id, created_at DESC);
CREATE INDEX idx_enrollments_tutor   ON enrollments(tutor_id, status, created_at DESC);

-- One LIVE request per student and tutor. Asking again while a
-- request is still open would just be the same question twice.
CREATE UNIQUE INDEX idx_enrollments_open
  ON enrollments(student_id, tutor_id)
  WHERE status IN ('pending', 'accepted');

-- ------------------------------------------------------------
-- enrollment_subjects
-- ------------------------------------------------------------
-- What one request covers. A student wanting Maths, Physics and
-- Chemistry from the same tutor sends ONE request with three rows
-- here — one message to answer, not three.
-- ------------------------------------------------------------
CREATE TABLE enrollment_subjects (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id UUID    NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  subject_id    INTEGER NOT NULL REFERENCES subjects(id)    ON DELETE CASCADE,

  -- Copied from the tutor's price list at the time of asking, so
  -- a later price change does not silently rewrite what was
  -- agreed.
  monthly_fee   INTEGER NOT NULL DEFAULT 0,

  UNIQUE (enrollment_id, subject_id)
);

CREATE INDEX idx_enrollment_subjects ON enrollment_subjects(enrollment_id);

-- ------------------------------------------------------------
-- 8. reviews
-- ------------------------------------------------------------
-- Only after a COMPLETED enrollment, and one per student per
-- tutor. Both limits matter: without the first, anybody could rate
-- a tutor they never met; without the second, one person could
-- post the same opinion twenty times.
-- ------------------------------------------------------------
CREATE TABLE reviews (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tutor_id      UUID NOT NULL REFERENCES tutors(id) ON DELETE CASCADE,
  student_id    UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,

  -- The finished tuition this review is about — the proof it
  -- actually happened.
  enrollment_id UUID REFERENCES enrollments(id) ON DELETE SET NULL,

  rating        INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment       TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (tutor_id, student_id)
);

CREATE INDEX idx_reviews_tutor ON reviews(tutor_id, created_at DESC);

-- ------------------------------------------------------------
-- 9. reports
-- ------------------------------------------------------------
-- Flagging a tutor to the administrator. Kept apart from reviews
-- on purpose: a review is public and about teaching, a report is
-- private and about conduct.
-- ------------------------------------------------------------
CREATE TABLE reports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  reporter_id   UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  tutor_id      UUID NOT NULL REFERENCES tutors(id) ON DELETE CASCADE,

  -- The dealing this complaint is about. Reporting is only
  -- possible after an enrollment, so a grudge from somebody who
  -- never met the tutor cannot reach the admin queue.
  enrollment_id UUID REFERENCES enrollments(id) ON DELETE SET NULL,

  reason        VARCHAR(60) NOT NULL,
  details       TEXT,

  -- open      = nobody has looked at it
  -- reviewed  = an admin looked and acted
  -- dismissed = an admin looked and found nothing in it
  status        VARCHAR(20) NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'reviewed', 'dismissed')),

  admin_note    TEXT,
  handled_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  handled_at    TIMESTAMPTZ,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_reports_status ON reports(status, created_at DESC);
CREATE INDEX idx_reports_tutor  ON reports(tutor_id);

-- ------------------------------------------------------------
-- 10. payments
-- ------------------------------------------------------------
-- A tutor telling the administrator they have paid, with a photo
-- of the receipt. The money moves outside the app — Easypaisa
-- needs a registered business — so this is the record of the
-- claim, and an administrator confirms it.
-- ------------------------------------------------------------
CREATE TABLE payments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tutor_id      UUID NOT NULL REFERENCES tutors(id) ON DELETE CASCADE,

  amount        INTEGER,
  method        VARCHAR(40),          -- Easypaisa, JazzCash, bank, cash
  reference     VARCHAR(80),          -- transaction id from the receipt
  note          TEXT,                 -- what the tutor wants to say

  -- The receipt image. Sensitive enough to live with the identity
  -- documents rather than the public avatars.
  receipt       VARCHAR(120),

  -- pending   = the administrator has not looked yet
  -- confirmed = accepted; the subscription was extended
  -- rejected  = not accepted, with a reason
  status        VARCHAR(20) NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'confirmed', 'rejected')),

  admin_note    TEXT,
  handled_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  handled_at    TIMESTAMPTZ,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_payments_status ON payments(status, created_at DESC);
CREATE INDEX idx_payments_tutor  ON payments(tutor_id, created_at DESC);

-- ------------------------------------------------------------
-- 11. videos
-- ------------------------------------------------------------
-- Recorded lessons a tutor shares with students learning online.
--
-- The video itself is NOT stored here. It is a link to YouTube,
-- Drive or similar, because a lesson recording is hundreds of
-- megabytes and serving those off a laptop in Skardu would fall
-- over on the first class that watched one.
-- ------------------------------------------------------------
CREATE TABLE videos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tutor_id      UUID    NOT NULL REFERENCES tutors(id)   ON DELETE CASCADE,
  subject_id    INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,

  title         VARCHAR(160) NOT NULL,
  description   TEXT,
  url           TEXT NOT NULL,

  -- 'link' (YouTube/Drive/etc) or 'cloudinary' (uploaded straight
  -- from the phone). cloud_id/thumbnail/size_bytes are only ever
  -- set for the latter.
  source        VARCHAR(20) NOT NULL DEFAULT 'link'
                CHECK (source IN ('link', 'cloudinary')),
  cloud_id      TEXT,
  thumbnail     TEXT,
  size_bytes    BIGINT,

  -- Which classes it suits, so it is not offered to a Class 6
  -- student when it covers Class 12 work.
  class_from    INTEGER NOT NULL DEFAULT 1,
  class_to      INTEGER NOT NULL DEFAULT 12,

  duration_mins INTEGER,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_videos_tutor ON videos(tutor_id, created_at DESC);

-- ------------------------------------------------------------
-- 12. video_releases
-- ------------------------------------------------------------
-- WHO sees WHICH video, and from WHAT DAY.
--
-- One row per video per student, because the whole point is that a
-- tutor can drip a course out: this one today, the next tomorrow,
-- and a different schedule for a student who joined late.
--
-- A video with no rows here is visible to nobody. Sharing is
-- always an explicit act.
-- ------------------------------------------------------------
CREATE TABLE video_releases (
  video_id    UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  student_id  UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,

  -- Visible from this date onwards. Today means immediately.
  release_on  DATE NOT NULL DEFAULT CURRENT_DATE,

  -- Set the first time they open it, and never cleared again —
  -- the simple yes/no a badge can show at a glance.
  watched_at      TIMESTAMPTZ,

  -- How long, and how often. The video itself lives on YouTube,
  -- Drive or Cloudinary rather than on this server, so there is no
  -- player here to report exact playback position — instead the
  -- app counts real seconds while the student has the lesson open
  -- in front of them, in short heartbeats, and adds them up here.
  -- Approximate, but honest about being so.
  watched_seconds INTEGER NOT NULL DEFAULT 0,
  watch_count     INTEGER NOT NULL DEFAULT 0,
  last_watched_at TIMESTAMPTZ,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (video_id, student_id)
);

-- The student's own query is "what can I watch today".
CREATE INDEX idx_releases_student ON video_releases(student_id, release_on);

-- ------------------------------------------------------------
-- 13. quizzes
-- ------------------------------------------------------------
-- An online quiz a tutor sets for their students — class-wise, or
-- for anybody else they choose, exactly the way videos are shared:
-- released to named students from a named date, so nothing appears
-- until a tutor explicitly sends it.
-- ------------------------------------------------------------
CREATE TABLE quizzes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tutor_id        UUID    NOT NULL REFERENCES tutors(id)   ON DELETE CASCADE,
  subject_id      INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,

  title           VARCHAR(160) NOT NULL,
  description     TEXT,

  -- Same rule as videos: inherited from the subject the tutor is
  -- approved to teach, not chosen freely per quiz.
  class_from      INTEGER NOT NULL DEFAULT 1,
  class_to        INTEGER NOT NULL DEFAULT 12,

  -- Optional. A student who opens it after time is up can still see
  -- it, but the clock shown on their screen will already have run
  -- out.
  time_limit_mins INTEGER,

  -- A quiz being built question by question should not be visible
  -- to anybody until the tutor says it is ready.
  is_published    BOOLEAN NOT NULL DEFAULT false,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_quizzes_tutor ON quizzes(tutor_id, created_at DESC);

CREATE TABLE quiz_questions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_id       UUID NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,

  question_text TEXT    NOT NULL,
  order_index   INTEGER NOT NULL DEFAULT 0,
  points        INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_quiz_questions_quiz ON quiz_questions(quiz_id, order_index);

CREATE TABLE quiz_options (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id UUID NOT NULL REFERENCES quiz_questions(id) ON DELETE CASCADE,

  option_text TEXT    NOT NULL,
  is_correct  BOOLEAN NOT NULL DEFAULT false,
  order_index INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_quiz_options_question ON quiz_options(question_id, order_index);

-- WHO can take WHICH quiz, and from WHAT DAY — the same shape as
-- video_releases, and for the same reason: sharing is explicit.
CREATE TABLE quiz_releases (
  quiz_id     UUID NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  student_id  UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,

  release_on  DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (quiz_id, student_id)
);

CREATE INDEX idx_quiz_releases_student ON quiz_releases(student_id, release_on);

-- One attempt per student per quiz. Submitting twice would just be
-- the tutor's job to allow explicitly later (a retake feature), not
-- something to invent silently now.
CREATE TABLE quiz_attempts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_id      UUID NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  student_id   UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,

  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at TIMESTAMPTZ,

  score        INTEGER,
  max_score    INTEGER,

  UNIQUE (quiz_id, student_id)
);

CREATE INDEX idx_quiz_attempts_quiz    ON quiz_attempts(quiz_id, submitted_at DESC);
CREATE INDEX idx_quiz_attempts_student ON quiz_attempts(student_id);

-- What a student actually picked, question by question, so a
-- result can be reviewed rather than only scored.
CREATE TABLE quiz_answers (
  attempt_id  UUID NOT NULL REFERENCES quiz_attempts(id)  ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES quiz_questions(id) ON DELETE CASCADE,
  option_id   UUID REFERENCES quiz_options(id) ON DELETE SET NULL,
  is_correct  BOOLEAN NOT NULL DEFAULT false,

  PRIMARY KEY (attempt_id, question_id)
);

-- ------------------------------------------------------------
-- 13. messages
-- ------------------------------------------------------------
-- One-to-one chat between a tutor and a student. Both can write,
-- and only the two of them can read it.
--
-- There is no separate "conversation" row: a conversation IS the
-- messages between one tutor and one student, and inventing a
-- parent record would add a join without adding meaning.
-- ------------------------------------------------------------
CREATE TABLE messages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  tutor_id     UUID NOT NULL REFERENCES tutors(id) ON DELETE CASCADE,
  student_id   UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,

  -- Who wrote it. Simpler than a sender_id that could be either
  -- of two columns, and it cannot get out of step with the pair
  -- above.
  sender       VARCHAR(10) NOT NULL CHECK (sender IN ('tutor', 'student')),

  body         TEXT NOT NULL,
  read_at      TIMESTAMPTZ,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The common read is "this conversation, newest last".
CREATE INDEX idx_messages_pair ON messages(tutor_id, student_id, created_at);

-- And "what have I not read yet".
CREATE INDEX idx_messages_unread ON messages(student_id, read_at)
  WHERE read_at IS NULL;

-- ------------------------------------------------------------
-- 14. announcements
-- ------------------------------------------------------------
-- A tutor writing once to every student enrolled with them.
--
-- Kept apart from messages on purpose. An announcement is ONE row
-- read by many people; a message is one row between two. Storing
-- an announcement as a message per student would duplicate the
-- text, and worse, would let a student reply to it — which is
-- exactly what an announcement is not for.
-- ------------------------------------------------------------
CREATE TABLE announcements (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tutor_id    UUID NOT NULL REFERENCES tutors(id) ON DELETE CASCADE,

  body        TEXT NOT NULL,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_announcements_tutor ON announcements(tutor_id, created_at DESC);

-- Who has seen which announcement. A row appears only once a
-- student has read one, so "unread" is the absence of a row.
CREATE TABLE announcement_reads (
  announcement_id UUID NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  student_id      UUID NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
  read_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (announcement_id, student_id)
);

-- ------------------------------------------------------------
-- 15. notifications
-- ------------------------------------------------------------
CREATE TABLE notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        VARCHAR(40) NOT NULL,
  title       VARCHAR(160) NOT NULL,
  message     TEXT,
  is_read     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_user ON notifications(user_id, is_read, created_at DESC);
