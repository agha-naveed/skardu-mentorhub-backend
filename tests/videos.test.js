import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, shutdown, api, login, query, one } from './helpers.js';
import { mkStudent, mkVideo, release } from './fixtures.js';
import { makeToken } from '../helpers.js';

let tutor, tutorId, subjA, subjB;
before(async () => {
  await boot();
  tutor = await login('tutor@stf.pk');
  tutorId = tutor.user.tutor.id;
  [subjA, subjB] = tutor.user.tutor.subjects.map((s) => s.subject_id);
});
after(shutdown);

const share = (ids, qs = '') => api('GET', `/api/tutor/share-students?video_ids=${[].concat(ids).join(',')}${qs}`, { token: tutor.token });
const names = (list) => list.map((s) => s.full_name).sort();

test('the video decides who is eligible, and every exclusion says WHY', async () => {
  const video = await mkVideo({ tutorId, subjectId: subjA, from: 9, to: 10, field: 'engineering' });
  const ok      = await mkStudent({ name: 'Ok Eng', classLevel: 10, field: 'engineering', tutorId, subjectIds: [subjA] });
  await mkStudent({ name: 'Centre Kid', classLevel: 10, field: 'engineering', mode: 'centre', tutorId, subjectIds: [subjA] });
  await mkStudent({ name: 'Wrong Subject', classLevel: 10, field: 'engineering', tutorId, subjectIds: [subjB] });
  await mkStudent({ name: 'Too Young', classLevel: 7, tutorId, subjectIds: [subjA] });
  await mkStudent({ name: 'Medical Girl', classLevel: 10, field: 'medical', tutorId, subjectIds: [subjA] });
  await mkStudent({ name: 'No Field', classLevel: 10, tutorId, subjectIds: [subjA] });
  await mkStudent({ name: 'Pending', classLevel: 10, field: 'engineering', tutorId, subjectIds: [subjA], status: 'pending' });

  const r = await share(video.id);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.rule, { subject_id: subjA, subject_name: r.body.rule.subject_name, class_from: 9, class_to: 10, field: 'engineering', field_label: 'Engineering' });
  assert.ok(names(r.body.eligible).includes('Ok Eng'));
  assert.ok(!names(r.body.eligible).some((n) => ['Centre Kid', 'Wrong Subject', 'Too Young', 'Medical Girl', 'No Field', 'Pending'].includes(n)));

  const why = Object.fromEntries(r.body.excluded.map((s) => [s.full_name, s.reason]));
  assert.match(why['Centre Kid'], /in person/i);
  assert.match(why['Wrong Subject'], /Not enrolled in/);
  assert.match(why['Too Young'], /Class 7.*Class 9–10/);
  assert.match(why['Medical Girl'], /Medical, not Engineering/);
  assert.match(why['No Field'], /not set a field/i);
  assert.equal(why['Pending'], undefined, 'a request that was never accepted is not a student of this tutor');
  assert.ok(ok.id);
});

test('a video for everybody can be narrowed by field when sharing', async () => {
  const video = await mkVideo({ tutorId, subjectId: subjA, from: 9, to: 12, field: null });
  await mkStudent({ name: 'AllE', classLevel: 11, field: 'engineering', tutorId, subjectIds: [subjA] });
  await mkStudent({ name: 'AllM', classLevel: 12, field: 'medical', tutorId, subjectIds: [subjA] });
  await mkStudent({ name: 'AllC', classLevel: 9, field: 'computer_science', tutorId, subjectIds: [subjA] });

  const all = await share(video.id);
  for (const n of ['AllE', 'AllM', 'AllC']) assert.ok(names(all.body.eligible).includes(n));
  assert.equal(all.body.rule.field, null);

  const med = await share(video.id, '&field=medical');
  assert.ok(names(med.body.eligible).includes('AllM'));
  assert.ok(!names(med.body.eligible).includes('AllE') && !names(med.body.eligible).includes('AllC'));
  assert.ok(!med.body.excluded.some((s) => s.full_name === 'AllE'), 'a filter is not an exclusion');

  assert.equal((await share(video.id, '&field=astrology')).status, 400);
});

test('videos of different subjects, or different fields, cannot be shared together', async () => {
  const a = await mkVideo({ tutorId, subjectId: subjA });
  const b = await mkVideo({ tutorId, subjectId: subjB });
  assert.match((await share([a.id, b.id])).body.error, /one subject at a time/i);
  const e = await mkVideo({ tutorId, subjectId: subjA, field: 'engineering' });
  const m = await mkVideo({ tutorId, subjectId: subjA, field: 'medical' });
  assert.match((await share([e.id, m.id])).body.error, /different fields/i);
});

test('input checks and ownership', async () => {
  assert.equal((await api('GET', '/api/tutor/share-students', { token: tutor.token })).status, 400);
  assert.equal((await share('not-a-uuid')).status, 400);
  assert.equal((await share('00000000-0000-0000-0000-000000000000')).status, 400);
  assert.equal((await share(await (async () => (await mkVideo({ tutorId, subjectId: subjA })).id)(), '&month=oct')).status, 400);
  const student = await login('student@stf.pk');
  assert.equal((await api('GET', '/api/tutor/share-students?video_ids=x', { token: student.token })).status, 403);
  assert.equal((await api('GET', '/api/tutor/share-students?video_ids=x')).status, 401);
});

test('release is re-checked on the server: ineligible students are skipped, with reasons', async () => {
  const video = await mkVideo({ tutorId, subjectId: subjA, from: 9, to: 10, field: 'medical', title: 'Release check' });
  const good = await mkStudent({ name: 'RelGood', classLevel: 9, field: 'medical', tutorId, subjectIds: [subjA] });
  const bad  = await mkStudent({ name: 'RelBad', classLevel: 9, field: 'engineering', tutorId, subjectIds: [subjA] });

  const r = await api('POST', '/api/tutor/videos/release', { token: tutor.token, body: { video_ids: [video.id], student_ids: [good.id, bad.id] } });
  assert.equal(r.status, 200);
  assert.equal(r.body.students, 1);
  assert.equal(r.body.skipped.length, 1);
  assert.match(r.body.skipped[0].reason, /Engineering, not Medical/);

  assert.equal((await query('SELECT 1 FROM video_releases WHERE video_id=$1 AND student_id=$2', [video.id, good.id])).length, 1);
  assert.equal((await query('SELECT 1 FROM video_releases WHERE video_id=$1 AND student_id=$2', [video.id, bad.id])).length, 0);
  assert.equal((await query(`SELECT 1 FROM notifications WHERE user_id=$1 AND type='video_shared'`, [good.id])).length, 1);

  const none = await api('POST', '/api/tutor/videos/release', { token: tutor.token, body: { video_ids: [video.id], student_ids: [bad.id] } });
  assert.equal(none.status, 400);
  assert.match(none.body.error, /RelBad: Follows Engineering/);

  assert.equal((await api('POST', '/api/tutor/videos/release', { token: tutor.token, body: { video_ids: [], student_ids: [good.id] } })).status, 400);
  assert.equal((await api('POST', '/api/tutor/videos/release', { token: tutor.token, body: { video_ids: [video.id], student_ids: [good.id], release_on: 'soon' } })).status, 400);
});

test('a future release date is scheduled and does not notify yet', async () => {
  const video = await mkVideo({ tutorId, subjectId: subjA, title: 'Future one' });
  const s = await mkStudent({ name: 'FutureKid', classLevel: 10, tutorId, subjectIds: [subjA] });
  const d = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const r = await api('POST', '/api/tutor/videos/release', { token: tutor.token, body: { video_ids: [video.id], student_ids: [s.id], release_on: d } });
  assert.equal(r.body.scheduled, true);
  assert.equal((await query(`SELECT 1 FROM notifications WHERE user_id=$1 AND type='video_shared'`, [s.id])).length, 0);
});

// ------------------------------------------------------------
// Watching
// ------------------------------------------------------------
async function watcher(over = {}) {
  const video = await mkVideo({ tutorId, subjectId: subjA, mins: 10, ...over });
  const s = await mkStudent({ name: `Watcher ${Math.random()}`, classLevel: 10, tutorId, subjectIds: [subjA] });
  await release(video.id, s.id, 0);
  // Signed directly: logging in dozens of fixture users would (rightly)
  // trip the login rate limit.
  return { video, student: s, token: makeToken({ id: s.id, role: 'student' }) };
}
const ping = (w, body) => api('POST', `/api/videos/${w.video.id}/watch`, { token: w.token, body });
const age = (sessionId, seconds) => query(`UPDATE video_watch_sessions SET last_seen_at = now() - ($2 || ' seconds')::interval WHERE id=$1`, [sessionId, String(seconds)]);

test('first report starts a sitting; later ones add real playing time', async () => {
  const w = await watcher();
  const first = await ping(w, { position: 0, duration: 600, method: 'playing' });
  assert.equal(first.status, 200);
  assert.equal(first.body.watched_seconds, 0);
  assert.equal(first.body.watch_count, 1);
  const sid = first.body.session_id;

  await age(sid, 10);
  const second = await ping(w, { session_id: sid, seconds: 10, position: 10 });
  assert.equal(second.body.watched_seconds, 10);
  await age(sid, 10);
  const third = await ping(w, { session_id: sid, seconds: 10, position: 20, completed: false });
  assert.equal(third.body.watched_seconds, 20);

  const s = await one('SELECT seconds, max_position_seconds, completed FROM video_watch_sessions WHERE id=$1', [sid]);
  assert.equal(s.seconds, 20); assert.equal(s.max_position_seconds, 20); assert.equal(s.completed, false);
  assert.equal((await one('SELECT duration_seconds FROM videos WHERE id=$1', [w.video.id])).duration_seconds, 600, 'the real length is stored');
});

test('CANNOT inflate: claiming 30 s straight away credits about 1 s; a huge claim is capped', async () => {
  const w = await watcher();
  const sid = (await ping(w, { position: 0 })).body.session_id;
  const cheat = await ping(w, { session_id: sid, seconds: 30, position: 30 });
  assert.ok(cheat.body.watched_seconds <= 2, `credited ${cheat.body.watched_seconds}`);
  await age(sid, 3600);
  const big = await ping(w, { session_id: sid, seconds: 99999, position: 10 });
  assert.ok(big.body.watched_seconds - cheat.body.watched_seconds <= 30, 'one report never credits more than 30 s');
});

test('a second sitting is a second history row; completion is remembered', async () => {
  const w = await watcher();
  const a = (await ping(w, { position: 0 })).body.session_id;
  await age(a, 10); await ping(w, { session_id: a, seconds: 10, position: 590, completed: true });
  const b = (await ping(w, { position: 0 })).body.session_id;
  assert.notEqual(a, b);
  assert.equal((await one('SELECT watch_count FROM video_releases WHERE video_id=$1 AND student_id=$2', [w.video.id, w.student.id])).watch_count, 2);
  const mine = await api('GET', `/api/videos/${w.video.id}/history`, { token: w.token });
  assert.equal(mine.body.sessions.length, 2);
  assert.equal(mine.body.sessions.find((s) => s.id === a).completed, true);
});

test('only the right student, and only a released video, can report', async () => {
  const w = await watcher();
  const other = await watcher();
  const sid = (await ping(w, { position: 0 })).body.session_id;
  assert.equal((await api('POST', `/api/videos/${w.video.id}/watch`, { token: other.token, body: { session_id: sid, seconds: 5 } })).status, 404, 'not shared with them');
  assert.equal((await api('POST', `/api/videos/${other.video.id}/watch`, { token: w.token, body: { session_id: sid, seconds: 5 } })).status, 404);
  assert.equal((await api('POST', `/api/videos/${w.video.id}/watch`, { token: w.token, body: { session_id: 'nope', seconds: 5 } })).status, 404);

  const later = await mkVideo({ tutorId, subjectId: subjA });
  await release(later.id, w.student.id, 3);
  assert.equal((await api('POST', `/api/videos/${later.id}/watch`, { token: w.token, body: {} })).status, 404, 'not released yet');
  assert.equal((await api('POST', `/api/videos/${w.video.id}/watch`, { body: {} })).status, 401);
  assert.equal((await api('POST', `/api/videos/${w.video.id}/watch`, { token: tutor.token, body: {} })).status, 403);
});

test('the tutor sees minutes watched, how far, and the full sitting history', async () => {
  const w = await watcher({ mins: 10 });
  const sid = (await ping(w, { position: 0, duration: 600 })).body.session_id;
  await age(sid, 30); await ping(w, { session_id: sid, seconds: 30, position: 300 });
  const sid2 = (await ping(w, { position: 0 })).body.session_id;
  await age(sid2, 20); await ping(w, { session_id: sid2, seconds: 20, position: 120 });

  const list = await api('GET', `/api/tutor/videos/${w.video.id}/watchers`, { token: tutor.token });
  assert.equal(list.status, 200);
  const row = list.body.watchers.find((x) => x.student_id === w.student.id);
  assert.equal(row.watched_seconds, 50);
  assert.equal(row.watched_minutes, 0.8);
  assert.equal(row.watch_count, 2);
  assert.equal(row.furthest_seconds, 300);
  assert.equal(row.furthest_percent, 50);

  const hist = await api('GET', `/api/tutor/videos/${w.video.id}/history/${w.student.id}`, { token: tutor.token });
  assert.equal(hist.status, 200);
  assert.equal(hist.body.sessions.length, 2);
  assert.equal(hist.body.total_seconds, 50);
  assert.deepEqual(hist.body.sessions.map((s) => s.seconds).sort((a, b) => a - b), [20, 30]);
  assert.ok(hist.body.sessions[0].started_at && hist.body.sessions[0].ended_at);
});

test('history is private to the video\'s own tutor', async () => {
  const w = await watcher();
  await query(`UPDATE tutors SET teaching_modes = ARRAY['online'], verification_status = 'verified'
                WHERE user_id = (SELECT id FROM users WHERE email = 'tutor2@stf.pk')`);
  const t2 = makeToken({ id: (await one(`SELECT id FROM users WHERE email='tutor2@stf.pk'`)).id, role: 'tutor' });

  assert.equal((await api('GET', `/api/tutor/videos/${w.video.id}/watchers`, { token: t2 })).status, 404, 'another online tutor');
  assert.equal((await api('GET', `/api/tutor/videos/${w.video.id}/history/${w.student.id}`, { token: t2 })).status, 404);
  assert.equal((await api('GET', `/api/tutor/videos/${w.video.id}/watchers`, { token: w.token })).status, 403, 'a student');
  assert.equal((await api('GET', `/api/tutor/videos/nope/watchers`, { token: tutor.token })).status, 404);
  assert.equal((await api('GET', `/api/tutor/videos/${w.video.id}/history/${w.student.id}`)).status, 401);
  assert.equal((await api('GET', `/api/tutor/videos/${w.video.id}/watchers`, { token: tutor.token })).status, 200);
});
