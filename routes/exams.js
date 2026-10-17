// ============================================================
// Online exams — MCQ only, 15 seconds a question
// ============================================================
// The SERVER owns the clock. The phone only displays it.
//
//   · Each question has a deadline: question_started_at + 15 s.
//   · An answer after the deadline is not accepted; the question
//     is recorded as timed out and the exam moves on.
//   · The exam keeps moving even if the app is closed — a sweep
//     (see jobs/cron.js) finishes abandoned attempts, so walking
//     away does not buy extra time.
//   · The student is never sent the correct answers, and cannot
//     ask for a question that is not the current one.
//   · Going back, switching app or leaving the screen is reported
//     by the app; the server marks THAT question as cheating
//     (scores zero), logs when it happened, and the exam goes on.
//
// All state changes happen inside a transaction that locks the
// attempt row, so two requests arriving together (a double-tap,
// a flaky connection retrying) cannot both be applied.
// ============================================================
import { Router } from 'express';
import { pool, query, one } from '../db.js';
import { requireLogin, requireRole, handle, logActivity, notify } from '../helpers.js';

export const router = Router();

// A reply that lands a moment after the deadline because of network
// delay still counts. Without this a slow connection would lose
// answers the student gave in time.
export const GRACE_MS = 1500;
export const CHEAT_KINDS = ['back_button', 'app_switch', 'screen_leave'];

// ------------------------------------------------------------
// Access
// ------------------------------------------------------------
async function releasedExam(quizId, studentId) {
  return one(
    `SELECT q.id, q.title, q.description, q.tutor_id, q.seconds_per_question,
            t.user_id AS tutor_user_id
       FROM quiz_releases r
       JOIN quizzes q ON q.id = r.quiz_id
       JOIN tutors  t ON t.id = q.tutor_id
      WHERE r.quiz_id = $1 AND r.student_id = $2
        AND r.release_on <= CURRENT_DATE
        AND q.is_published = true
        AND EXISTS (
          SELECT 1 FROM enrollments e
           WHERE e.student_id = r.student_id AND e.tutor_id = q.tutor_id
             AND e.status IN ('accepted', 'completed'))`,
    [quizId, studentId]
  );
}

const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v));

async function questionsOf(db, quizId) {
  const rows = await db.query(
    `SELECT id, question_text, points, order_index
       FROM quiz_questions WHERE quiz_id = $1 ORDER BY order_index, id`, [quizId]);
  return rows.rows;
}

// ------------------------------------------------------------
// The clock
// ------------------------------------------------------------
// Moves the attempt forward over every question whose time is up.
// Deterministic: when a question times out, the next one's clock
// starts at the OLD deadline, not "now", so the total can never be
// stretched by being offline.
// Returns true if the exam finished.
// ------------------------------------------------------------
async function settle(db, attempt, questions, now = Date.now()) {
  // Already finished (including attempts from the old untimed flow,
  // which have no clock at all) — nothing to move.
  if (attempt.submitted_at || !attempt.question_started_at) return false;

  const secsMs = attempt.seconds_per_question * 1000;
  let idx = attempt.current_index;
  let qstart = new Date(attempt.question_started_at).getTime();

  while (idx < questions.length && now >= qstart + secsMs + GRACE_MS) {
    await db.query(
      `INSERT INTO quiz_answers (attempt_id, question_id, option_id, is_correct, timed_out)
       VALUES ($1, $2, NULL, false, true)
       ON CONFLICT (attempt_id, question_id) DO NOTHING`,
      [attempt.id, questions[idx].id]
    );
    idx += 1;
    qstart += secsMs;
  }

  attempt.current_index = idx;
  attempt.question_started_at = new Date(qstart);

  if (idx >= questions.length) {
    await finish(db, attempt, questions);
    return true;
  }

  await db.query(
    `UPDATE quiz_attempts SET current_index = $2, question_started_at = $3 WHERE id = $1`,
    [attempt.id, idx, attempt.question_started_at]
  );
  return false;
}

async function finish(db, attempt, questions) {
  const score = await db.query(
    `SELECT COALESCE(SUM(qq.points) FILTER (WHERE a.is_correct AND NOT a.cheated), 0)::int AS score
       FROM quiz_questions qq
       LEFT JOIN quiz_answers a ON a.question_id = qq.id AND a.attempt_id = $1
      WHERE qq.quiz_id = $2`,
    [attempt.id, attempt.quiz_id]
  );
  const max = questions.reduce((n, q) => n + q.points, 0);

  const done = await db.query(
    `UPDATE quiz_attempts
        SET submitted_at = now(), score = $2, max_score = $3, current_index = $4
      WHERE id = $1 AND submitted_at IS NULL
      RETURNING score, max_score`,
    [attempt.id, score.rows[0].score, max, questions.length]
  );
  if (done.rows[0]) {
    attempt.submitted_at = new Date();
    attempt.score = done.rows[0].score;
    attempt.max_score = done.rows[0].max_score;
    attempt._justFinished = true;
  }
}

// Runs fn(db, attempt, questions) with the attempt row locked.
async function withAttempt(quizId, studentId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      `SELECT a.*, q.seconds_per_question, q.title
         FROM quiz_attempts a JOIN quizzes q ON q.id = a.quiz_id
        WHERE a.quiz_id = $1 AND a.student_id = $2 FOR UPDATE OF a`,
      [quizId, studentId]
    );
    const attempt = found.rows[0];
    if (!attempt) { await client.query('ROLLBACK'); return { notStarted: true }; }
    const questions = await questionsOf(client, quizId);
    const result = await fn(client, attempt, questions);
    await client.query('COMMIT');
    return { result, attempt, questions };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// What the phone is allowed to see.
async function stateFor(attempt, questions) {
  const base = { cheat_count: attempt.cheat_count, total: questions.length, title: attempt.title };

  if (attempt.submitted_at) {
    return { ...base, status: 'submitted', score: attempt.score, max_score: attempt.max_score };
  }

  const secs = attempt.seconds_per_question;
  const q = questions[attempt.current_index];
  const deadline = new Date(attempt.question_started_at).getTime() + secs * 1000;
  const options = await query(
    // NEVER is_correct.
    `SELECT id, option_text, order_index FROM quiz_options
      WHERE question_id = $1 ORDER BY order_index, id`, [q.id]);

  return {
    ...base,
    status: 'in_progress',
    index: attempt.current_index,
    seconds_per_question: secs,
    // The phone counts down from this, using its own stopwatch, so
    // a wrong clock on the device cannot give extra time.
    remaining_ms: Math.max(0, deadline - Date.now()),
    server_time: new Date().toISOString(),
    question: {
      id: q.id, number: attempt.current_index + 1,
      text: q.question_text, points: q.points,
      options: options.map((o) => ({ id: o.id, text: o.option_text })),
    },
  };
}

async function announceFinished(req, attempt, exam) {
  await logActivity(req.user, 'exam_submitted',
    `Finished "${exam.title}" — ${attempt.score}/${attempt.max_score}` +
    (attempt.cheat_count ? `, ${attempt.cheat_count} cheating flag${attempt.cheat_count === 1 ? '' : 's'}` : ''), req.ip);
}

// ------------------------------------------------------------
// Before starting
// ------------------------------------------------------------
router.get('/api/exams/:id', requireLogin, requireRole('student'), handle(async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'That exam is not available to you.' });
  const exam = await releasedExam(req.params.id, req.user.id);
  if (!exam) return res.status(404).json({ error: 'That exam is not available to you.' });

  const count = await one('SELECT COUNT(*)::int AS n FROM quiz_questions WHERE quiz_id = $1', [exam.id]);
  const attempt = await one(
    'SELECT submitted_at, score, max_score FROM quiz_attempts WHERE quiz_id = $1 AND student_id = $2',
    [exam.id, req.user.id]
  );

  res.json({
    id: exam.id, title: exam.title, description: exam.description,
    question_count: count.n,
    seconds_per_question: exam.seconds_per_question,
    status: !attempt ? 'not_started' : attempt.submitted_at ? 'submitted' : 'in_progress',
    score: attempt?.score ?? null, max_score: attempt?.max_score ?? null,
  });
}));

// ------------------------------------------------------------
// Start, or pick up where they were
// ------------------------------------------------------------
router.post('/api/exams/:id/start', requireLogin, requireRole('student'), handle(async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'That exam is not available to you.' });
  const exam = await releasedExam(req.params.id, req.user.id);
  if (!exam) return res.status(404).json({ error: 'That exam is not available to you.' });

  const count = await one('SELECT COUNT(*)::int AS n FROM quiz_questions WHERE quiz_id = $1', [exam.id]);
  if (count.n === 0) return res.status(400).json({ error: 'This exam has no questions yet.' });

  // One attempt per student per exam. ON CONFLICT makes a double-tap
  // on "Start" harmless.
  const inserted = await one(
    `INSERT INTO quiz_attempts (quiz_id, student_id, question_started_at, current_index)
     VALUES ($1, $2, now(), 0)
     ON CONFLICT (quiz_id, student_id) DO NOTHING
     RETURNING id`,
    [exam.id, req.user.id]
  );
  if (inserted) await logActivity(req.user, 'exam_started', `Started "${exam.title}"`, req.ip);

  // An attempt created by the old (pre-timer) flow has no clock.
  await query(
    `UPDATE quiz_attempts SET question_started_at = now()
      WHERE quiz_id = $1 AND student_id = $2 AND question_started_at IS NULL AND submitted_at IS NULL`,
    [exam.id, req.user.id]
  );

  const out = await withAttempt(exam.id, req.user.id, (db, attempt, questions) =>
    settle(db, attempt, questions));
  if (out.notStarted) return res.status(500).json({ error: 'Could not start the exam. Try again.' });
  if (out.attempt._justFinished) await announceFinished(req, out.attempt, exam);

  res.json(await stateFor(out.attempt, out.questions));
}));

// ------------------------------------------------------------
// Where am I? (after a reconnect, or reopening the app)
// ------------------------------------------------------------
router.get('/api/exams/:id/state', requireLogin, requireRole('student'), handle(async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'That exam is not available to you.' });
  const exam = await releasedExam(req.params.id, req.user.id);
  if (!exam) return res.status(404).json({ error: 'That exam is not available to you.' });

  const out = await withAttempt(exam.id, req.user.id, (db, attempt, questions) =>
    attempt.submitted_at ? false : settle(db, attempt, questions));
  if (out.notStarted) return res.status(400).json({ error: 'Start the exam first.' });
  if (out.attempt._justFinished) await announceFinished(req, out.attempt, exam);

  res.json(await stateFor(out.attempt, out.questions));
}));

// ------------------------------------------------------------
// Answer the current question (or report that time ran out)
// ------------------------------------------------------------
router.post('/api/exams/:id/answer', requireLogin, requireRole('student'), handle(async (req, res) => {
  const { question_id: questionId, option_id: optionId = null } = req.body || {};
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'That exam is not available to you.' });
  if (!isUuid(questionId)) return res.status(400).json({ error: 'Which question is this for?' });
  if (optionId != null && !isUuid(optionId)) return res.status(400).json({ error: 'That option does not exist.' });

  const exam = await releasedExam(req.params.id, req.user.id);
  if (!exam) return res.status(404).json({ error: 'That exam is not available to you.' });

  let problem = null;

  const out = await withAttempt(exam.id, req.user.id, async (db, attempt, questions) => {
    if (attempt.submitted_at) { problem = { status: 409, error: 'This exam is already finished.' }; return false; }

    // Anything that ran out of time while the phone was away.
    if (await settle(db, attempt, questions)) { problem = { status: 409, error: 'Time is up. The exam has finished.' }; return true; }

    const current = questions[attempt.current_index];
    if (current.id !== questionId) {
      problem = { status: 409, error: 'That question has already closed.' };
      return false;
    }

    const secsMs = attempt.seconds_per_question * 1000;
    const qstart = new Date(attempt.question_started_at).getTime();
    const now = Date.now();

    if (optionId == null) {
      // "Time is up" from the phone. Believed only if the server's own
      // clock agrees — otherwise a student could skip questions at will.
      if (now < qstart + secsMs - GRACE_MS) {
        problem = { status: 400, error: 'There is still time on this question.' };
        return false;
      }
      await db.query(
        `INSERT INTO quiz_answers (attempt_id, question_id, option_id, is_correct, timed_out)
         VALUES ($1, $2, NULL, false, true)
         ON CONFLICT (attempt_id, question_id) DO NOTHING`,
        [attempt.id, current.id]
      );
    } else {
      const opt = await db.query(
        'SELECT is_correct FROM quiz_options WHERE id = $1 AND question_id = $2',
        [optionId, current.id]
      );
      if (!opt.rows[0]) { problem = { status: 400, error: 'That option does not belong to this question.' }; return false; }

      // A question already marked as cheating stays at zero, whatever
      // they pick afterwards.
      await db.query(
        `INSERT INTO quiz_answers (attempt_id, question_id, option_id, is_correct, answered_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (attempt_id, question_id) DO UPDATE
           SET option_id = EXCLUDED.option_id,
               is_correct = EXCLUDED.is_correct AND NOT quiz_answers.cheated,
               answered_at = now()`,
        [attempt.id, current.id, optionId, opt.rows[0].is_correct]
      );
    }

    // On time: the next question starts now. In the grace window:
    // it starts at the old deadline, so the grace is not a bonus.
    attempt.current_index += 1;
    attempt.question_started_at = new Date(Math.min(now, qstart + secsMs));

    if (attempt.current_index >= questions.length) {
      await finish(db, attempt, questions);
    } else {
      await db.query(
        'UPDATE quiz_attempts SET current_index = $2, question_started_at = $3 WHERE id = $1',
        [attempt.id, attempt.current_index, attempt.question_started_at]
      );
    }
    return true;
  });

  if (out.notStarted) return res.status(400).json({ error: 'Start the exam first.' });
  if (out.attempt._justFinished) await announceFinished(req, out.attempt, exam);
  if (problem) return res.status(problem.status).json({ error: problem.error, state: await stateFor(out.attempt, out.questions) });

  res.json(await stateFor(out.attempt, out.questions));
}));

// ------------------------------------------------------------
// The app reports: back button, switched app, left the screen
// ------------------------------------------------------------
// The server decides WHICH question — always the current one — so the
// app cannot blame a question that is already over, or dodge by
// naming another.
// ------------------------------------------------------------
router.post('/api/exams/:id/cheat', requireLogin, requireRole('student'), handle(async (req, res) => {
  const kind = String(req.body?.kind || '');
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'That exam is not available to you.' });
  if (!CHEAT_KINDS.includes(kind)) return res.status(400).json({ error: 'Unknown event.' });

  const exam = await releasedExam(req.params.id, req.user.id);
  if (!exam) return res.status(404).json({ error: 'That exam is not available to you.' });

  let first = false;
  let flagged = false;

  const out = await withAttempt(exam.id, req.user.id, async (db, attempt, questions) => {
    if (attempt.submitted_at) return false;
    if (await settle(db, attempt, questions)) return true;

    const current = questions[attempt.current_index];
    flagged = true;

    await db.query(
      `INSERT INTO exam_cheat_events (attempt_id, quiz_id, student_id, question_id, kind)
       VALUES ($1, $2, $3, $4, $5)`,
      [attempt.id, attempt.quiz_id, req.user.id, current.id, kind]
    );
    // Zero for this question — and it stays zero if they answer later.
    await db.query(
      `INSERT INTO quiz_answers (attempt_id, question_id, option_id, is_correct, cheated)
       VALUES ($1, $2, NULL, false, true)
       ON CONFLICT (attempt_id, question_id) DO UPDATE SET cheated = true, is_correct = false`,
      [attempt.id, current.id]
    );
    first = attempt.cheat_count === 0;
    attempt.cheat_count += 1;
    await db.query('UPDATE quiz_attempts SET cheat_count = $2 WHERE id = $1', [attempt.id, attempt.cheat_count]);
    return true;
  });

  if (out.notStarted) return res.status(400).json({ error: 'Start the exam first.' });
  if (out.attempt._justFinished) await announceFinished(req, out.attempt, exam);

  if (flagged) {
    await logActivity(req.user, 'exam_cheating',
      `Cheating flag in "${exam.title}" (${kind.replace('_', ' ')})`, req.ip);

    // Once per attempt — a tutor does not need a buzz for every glance.
    if (first) {
      await notify(exam.tutor_user_id, 'exam_cheating', 'Possible cheating in an exam',
        `${req.user.full_name} left the exam screen during "${exam.title}". See the exam results for details.`,
        { quiz_id: exam.id });
    }
  }

  res.json(await stateFor(out.attempt, out.questions));
}));

// ============================================================
// Tutor and admin views
// ============================================================
async function eventsFor(filter, params) {
  return query(
    `SELECT e.id, e.kind, e.occurred_at,
            u.id AS student_id, u.full_name AS student_name,
            q.id AS quiz_id, q.title AS exam_title,
            qq.question_text, qq.order_index + 1 AS question_number,
            tu.full_name AS tutor_name
       FROM exam_cheat_events e
       JOIN users u     ON u.id = e.student_id
       JOIN quizzes q   ON q.id = e.quiz_id
       JOIN tutors t    ON t.id = q.tutor_id
       JOIN users tu    ON tu.id = t.user_id
       LEFT JOIN quiz_questions qq ON qq.id = e.question_id
      WHERE ${filter}
      ORDER BY e.occurred_at DESC
      LIMIT 500`,
    params
  );
}

// Every flag in one of the tutor's own exams, with the time.
router.get('/api/tutor/exams/:id/cheating', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'That exam does not exist.' });
  const tutor = await one('SELECT id FROM tutors WHERE user_id = $1', [req.user.id]);
  const quiz = tutor && await one('SELECT id, title FROM quizzes WHERE id = $1 AND tutor_id = $2', [req.params.id, tutor.id]);
  if (!quiz) return res.status(404).json({ error: 'That exam does not exist.' });

  res.json({ exam: quiz, events: await eventsFor('e.quiz_id = $1', [quiz.id]) });
}));

// The admin sees every attempt and every flag on the platform.
router.get('/api/admin/exams/results', requireLogin, requireRole('admin'), handle(async (req, res) => {
  const where = ['a.submitted_at IS NOT NULL'];
  const params = [];
  if (isUuid(req.query.student_id)) { params.push(req.query.student_id); where.push(`a.student_id = $${params.length}`); }
  if (isUuid(req.query.tutor_id))   { params.push(req.query.tutor_id);   where.push(`q.tutor_id = $${params.length}`); }
  if (req.query.flagged === '1') where.push('a.cheat_count > 0');

  res.json(await query(
    `SELECT a.id, a.score, a.max_score, a.cheat_count, a.submitted_at, a.started_at,
            q.id AS quiz_id, q.title AS exam_title,
            s.full_name AS student_name, s.id AS student_id,
            tu.full_name AS tutor_name
       FROM quiz_attempts a
       JOIN quizzes q ON q.id = a.quiz_id
       JOIN users s   ON s.id = a.student_id
       JOIN tutors t  ON t.id = q.tutor_id
       JOIN users tu  ON tu.id = t.user_id
      WHERE ${where.join(' AND ')}
      ORDER BY a.submitted_at DESC LIMIT 300`, params));
}));

router.get('/api/admin/exams/cheating', requireLogin, requireRole('admin'), handle(async (req, res) => {
  const params = [];
  const where = ['true'];
  if (isUuid(req.query.student_id)) { params.push(req.query.student_id); where.push(`e.student_id = $${params.length}`); }
  if (isUuid(req.query.quiz_id))    { params.push(req.query.quiz_id);    where.push(`e.quiz_id = $${params.length}`); }
  res.json({ events: await eventsFor(where.join(' AND '), params) });
}));

// ============================================================
// Finishing exams nobody is looking at
// ============================================================
// Called every 30 seconds by the scheduler. A student who closes the
// app mid-exam still runs out of time, and still gets a score.
// ============================================================
export async function sweepExpiredAttempts() {
  const stale = await query(
    `SELECT a.quiz_id, a.student_id
       FROM quiz_attempts a JOIN quizzes q ON q.id = a.quiz_id
      WHERE a.submitted_at IS NULL AND a.question_started_at IS NOT NULL
        AND a.question_started_at + make_interval(secs => q.seconds_per_question + 3) < now()
      LIMIT 200`
  );

  let finished = 0;
  for (const row of stale) {
    const out = await withAttempt(row.quiz_id, row.student_id, (db, attempt, questions) =>
      settle(db, attempt, questions));
    if (out.attempt?._justFinished) {
      finished += 1;
      const who = await one('SELECT id, role, full_name FROM users WHERE id = $1', [row.student_id]);
      await logActivity(who, 'exam_submitted',
        `Exam finished automatically — ${out.attempt.score}/${out.attempt.max_score}`);
    }
  }
  return finished;
}
