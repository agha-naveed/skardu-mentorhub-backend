import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, shutdown, api, login, query, one } from './helpers.js';
import { sweepExpiredAttempts } from '../routes/exams.js';

let tutor, student, student2, admin, subjectId;
before(async () => {
  await boot();
  tutor = await login('tutor@stf.pk');
  student = await login('student@stf.pk');
  student2 = await login('student2@stf.pk');
  admin = await login('admin@stf.pk');
  subjectId = tutor.user.tutor.subjects[0].subject_id;
});
after(shutdown);

// A published 3-question exam, released to Fatima. Correct option is
// always the one whose text starts with "RIGHT".
async function makeExam(title = `Exam ${Math.random()}`) {
  const questions = [1, 2, 3].map((n) => ({
    question_text: `Question ${n}?`, points: 2,
    options: [
      { option_text: 'wrong A' }, { option_text: `RIGHT ${n}`, is_correct: true }, { option_text: 'wrong B' },
    ],
  }));
  const c = await api('POST', '/api/tutor/quizzes', { token: tutor.token, body: { subject_id: subjectId, title, publish: true, questions } });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const r = await api('POST', '/api/tutor/quizzes/release', { token: tutor.token, body: { quiz_ids: [c.body.id], student_ids: [student.user.id] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return c.body.id;
}
const rightOption = async (questionId) =>
  (await one(`SELECT id FROM quiz_options WHERE question_id=$1 AND is_correct`, [questionId])).id;
const wrongOption = async (questionId) =>
  (await one(`SELECT id FROM quiz_options WHERE question_id=$1 AND NOT is_correct LIMIT 1`, [questionId])).id;
const rewind = (quizId, seconds) => query(
  `UPDATE quiz_attempts SET question_started_at = question_started_at - ($2 || ' seconds')::interval WHERE quiz_id=$1`,
  [quizId, String(seconds)]);
const start = (id) => api('POST', `/api/exams/${id}/start`, { token: student.token });
const answer = (id, q, o) => api('POST', `/api/exams/${id}/answer`, { token: student.token, body: { question_id: q, option_id: o } });
const cheat = (id, kind = 'app_switch') => api('POST', `/api/exams/${id}/cheat`, { token: student.token, body: { kind } });

test('start: 15 seconds, first question, no answer key leaked', async () => {
  const id = await makeExam();
  const s = await start(id);
  assert.equal(s.status, 200);
  assert.equal(s.body.status, 'in_progress');
  assert.equal(s.body.seconds_per_question, 15);
  assert.equal(s.body.total, 3);
  assert.equal(s.body.question.number, 1);
  assert.ok(s.body.remaining_ms > 13000 && s.body.remaining_ms <= 15000);
  assert.equal(s.body.question.options.length, 3);
  assert.ok(!JSON.stringify(s.body).includes('is_correct'), 'the answer key must never be sent');
  assert.ok(!JSON.stringify(s.body).includes('RIGHT') || s.body.question.options.some((o) => o.text.startsWith('RIGHT')));
});

test('a perfect run scores full marks and ends the exam', async () => {
  const id = await makeExam();
  let s = await start(id);
  for (let i = 0; i < 3; i++) {
    s = await answer(id, s.body.question.id, await rightOption(s.body.question.id));
    assert.equal(s.status, 200);
  }
  assert.equal(s.body.status, 'submitted');
  assert.equal(s.body.score, 6);
  assert.equal(s.body.max_score, 6);
  const again = await start(id);
  assert.equal(again.body.status, 'submitted', 'cannot retake');
  const late = await answer(id, 'x'.repeat(0) || '00000000-0000-0000-0000-000000000000', null);
  assert.ok([400, 409].includes(late.status));
});

test('next question starts a fresh 15 seconds', async () => {
  const id = await makeExam();
  let s = await start(id);
  await rewind(id, 10);                                  // 5s left on Q1
  s = await answer(id, s.body.question.id, await rightOption(s.body.question.id));
  assert.equal(s.body.question.number, 2);
  assert.ok(s.body.remaining_ms > 13000, `Q2 should have ~15s, got ${s.body.remaining_ms}`);
});

test('answering a question that is not the current one is refused', async () => {
  const id = await makeExam();
  const s = await start(id);
  const qs = await query(`SELECT id FROM quiz_questions WHERE quiz_id=$1 ORDER BY order_index`, [id]);
  const q3 = qs[2].id;
  const r = await answer(id, q3, await rightOption(q3));
  assert.equal(r.status, 409);
  const same = await api('GET', `/api/exams/${id}/state`, { token: student.token });
  assert.equal(same.body.question.id, s.body.question.id, 'still on question 1');
});

test('an option from another question is refused', async () => {
  const id = await makeExam();
  const s = await start(id);
  const qs = await query(`SELECT id FROM quiz_questions WHERE quiz_id=$1 ORDER BY order_index`, [id]);
  const r = await answer(id, s.body.question.id, await rightOption(qs[1].id));
  assert.equal(r.status, 400);
});

test('SERVER ENFORCES TIME: an answer after the deadline is not accepted', async () => {
  const id = await makeExam();
  const s = await start(id);
  const q1 = s.body.question.id;
  const right = await rightOption(q1);
  await rewind(id, 20);                                  // way past 15s + grace
  const r = await answer(id, q1, right);
  assert.equal(r.status, 409, 'too late');
  const row = await one(`SELECT a.timed_out, a.is_correct FROM quiz_answers a JOIN quiz_attempts t ON t.id=a.attempt_id WHERE t.quiz_id=$1 AND a.question_id=$2`, [id, q1]);
  assert.equal(row.timed_out, true);
  assert.equal(row.is_correct, false, 'the late right answer scores nothing');
  assert.equal(r.body.state.question.number, 2, 'moved on automatically');
});

test('question moves on automatically when time runs out (state poll)', async () => {
  const id = await makeExam();
  await start(id);
  await rewind(id, 16.6);
  const st = await api('GET', `/api/exams/${id}/state`, { token: student.token });
  assert.equal(st.body.question.number, 2);
  assert.ok(st.body.remaining_ms > 12000, 'Q2 clock started at the old deadline, not later');
});

test('timeout signal: refused while there is time, accepted when time is up', async () => {
  const id = await makeExam();
  const s = await start(id);
  const early = await answer(id, s.body.question.id, null);
  assert.equal(early.status, 400, 'cannot skip a question early');
  await rewind(id, 14);                                  // 1s left, inside the 1.5s tolerance
  const ok = await answer(id, s.body.question.id, null);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.question.number, 2);
});

test('being away does not stop the clock: everything times out, score 0', async () => {
  const id = await makeExam();
  await start(id);
  await rewind(id, 200);
  const st = await api('GET', `/api/exams/${id}/state`, { token: student.token });
  assert.equal(st.body.status, 'submitted');
  assert.equal(st.body.score, 0);
});

test('abandoned exams are finished by the background sweep', async () => {
  const id = await makeExam();
  await start(id);
  await rewind(id, 100);
  const n = await sweepExpiredAttempts();
  assert.ok(n >= 1);
  const row = await one(`SELECT submitted_at, score FROM quiz_attempts WHERE quiz_id=$1`, [id]);
  assert.ok(row.submitted_at);
  assert.equal(row.score, 0);
});

test('CHEATING: that question scores zero, exam continues, event logged with time', async () => {
  const id = await makeExam();
  let s = await start(id);
  const q1 = s.body.question.id;

  const c = await cheat(id, 'app_switch');
  assert.equal(c.status, 200);
  assert.equal(c.body.status, 'in_progress', 'the exam keeps going');
  assert.equal(c.body.cheat_count, 1);
  assert.equal(c.body.question.id, q1, 'still on the same question');

  // even a correct answer after cheating scores nothing for that question
  s = await answer(id, q1, await rightOption(q1));
  assert.equal(s.body.question.number, 2);
  s = await answer(id, s.body.question.id, await rightOption(s.body.question.id));
  s = await answer(id, s.body.question.id, await rightOption(s.body.question.id));
  assert.equal(s.body.status, 'submitted');
  assert.equal(s.body.score, 4, 'Q1 voided: 2 + 2 of 6');
  assert.equal(s.body.cheat_count, 1);

  const ev = await query(`SELECT kind, occurred_at, question_id FROM exam_cheat_events WHERE quiz_id=$1`, [id]);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'app_switch');
  assert.equal(ev[0].question_id, q1);
  assert.ok(ev[0].occurred_at);
});

test('all three kinds are accepted; unknown kinds are not', async () => {
  const id = await makeExam();
  await start(id);
  for (const k of ['back_button', 'app_switch', 'screen_leave']) assert.equal((await cheat(id, k)).status, 200);
  assert.equal((await cheat(id, 'sneeze')).status, 400);
  const st = await api('GET', `/api/exams/${id}/state`, { token: student.token });
  assert.equal(st.body.cheat_count, 3);
});

test('tutor sees cheating events and the count in results; admin sees them too', async () => {
  const id = await makeExam('Cheat visibility');
  await start(id);
  await cheat(id, 'back_button');
  await cheat(id, 'screen_leave');

  const t = await api('GET', `/api/tutor/exams/${id}/cheating`, { token: tutor.token });
  assert.equal(t.status, 200);
  assert.equal(t.body.events.length, 2);
  assert.equal(t.body.events[0].student_name, 'Fatima Kazmi');
  assert.ok(t.body.events[0].occurred_at);
  assert.equal(t.body.events[0].question_number, 1);

  const res = await api('GET', `/api/tutor/quizzes/${id}/results`, { token: tutor.token });
  assert.equal(res.body.results.find((r) => r.student_id === student.user.id).cheat_count, 2);

  const a = await api('GET', `/api/admin/exams/cheating?quiz_id=${id}`, { token: admin.token });
  assert.equal(a.body.events.length, 2);

  // a different tutor / a student cannot read it
  assert.equal((await api('GET', `/api/tutor/exams/${id}/cheating`, { token: student.token })).status, 403);
  assert.equal((await api('GET', `/api/admin/exams/cheating`, { token: tutor.token })).status, 403);
});

test('the tutor is notified once per attempt, not once per event', async () => {
  const id = await makeExam('Notify once');
  await start(id);
  await cheat(id); await cheat(id); await cheat(id);
  const n = await query(`SELECT 1 FROM notifications WHERE type='exam_cheating' AND message LIKE '%Notify once%'`);
  assert.equal(n.length, 1);
});

test('result review shows cheated and timed-out flags', async () => {
  const id = await makeExam();
  let s = await start(id);
  await cheat(id);
  s = await answer(id, s.body.question.id, await rightOption(s.body.question.id));
  await rewind(id, 40);
  await api('GET', `/api/exams/${id}/state`, { token: student.token });
  const r = await api('GET', `/api/quizzes/${id}/result`, { token: student.token });
  assert.equal(r.status, 200);
  assert.equal(r.body.questions[0].cheated, true);
  assert.equal(r.body.questions[1].timed_out, true);
  assert.equal(r.body.cheat_count, 1);
});

test('double-tap: the same answer sent twice is applied once', async () => {
  const id = await makeExam();
  const s = await start(id);
  const q = s.body.question.id, o = await rightOption(q);
  const [a, b] = await Promise.all([answer(id, q, o), answer(id, q, o)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const st = await api('GET', `/api/exams/${id}/state`, { token: student.token });
  assert.equal(st.body.question.number, 2, 'advanced exactly one question');
});

test('access control', async () => {
  const id = await makeExam();
  assert.equal((await api('POST', `/api/exams/${id}/start`)).status, 401);
  assert.equal((await api('POST', `/api/exams/${id}/start`, { token: student2.token })).status, 404, 'not released to this student');
  assert.equal((await api('POST', `/api/exams/${id}/start`, { token: tutor.token })).status, 403);
  assert.equal((await api('POST', `/api/exams/not-a-uuid/start`, { token: student.token })).status, 404);
  assert.equal((await api('GET', `/api/exams/${id}/state`, { token: student.token })).status, 400, 'state before start');
});

test('an unpublished or empty exam cannot be started', async () => {
  const c = await api('POST', '/api/tutor/quizzes', { token: tutor.token, body: { subject_id: subjectId, title: 'Draft', publish: false, questions: [{ question_text: 'q?', options: [{ option_text: 'a', is_correct: true }, { option_text: 'b' }] }] } });
  await query(`INSERT INTO quiz_releases(quiz_id, student_id) VALUES($1,$2)`, [c.body.id, student.user.id]);
  assert.equal((await start(c.body.id)).status, 404);
});

test('audit log has started, submitted and cheating entries', async () => {
  const id = await makeExam('Audited');
  let s = await start(id);
  await cheat(id);
  for (let i = 0; i < 3; i++) s = await answer(id, s.body.question.id, await wrongOption(s.body.question.id));
  const acts = (await query(`SELECT action, detail FROM activity_log WHERE detail LIKE '%Audited%'`)).map((r) => r.action);
  for (const a of ['exam_started', 'exam_cheating', 'exam_submitted']) assert.ok(acts.includes(a), `missing ${a}: ${acts}`);
});
