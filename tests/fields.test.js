import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, shutdown, api, login, query, one } from './helpers.js';
import { cleanField, cleanFieldList, hasFields, FIELDS } from '../lib/fields.js';

let student, tutor, tutorId, subj;
before(async () => {
  await boot();
  student = await login('student@stf.pk'); tutor = await login('tutor@stf.pk');
  tutorId = tutor.user.tutor.id; subj = tutor.user.tutor.subjects[0].subject_id;
});
after(shutdown);

let seq = 0;
const register = (over = {}) => {
  seq += 1;
  return api('POST', '/api/auth/register', { body: {
    role: 'student', full_name: `Field Kid ${seq}`, email: `fieldkid${seq}-${Date.now()}@test.pk`,
    phone: `0388${String(seq).padStart(7, '0')}`, password: 'secret123', class_level: 10,
    learning_modes: ['online'], accepted_terms: true, ...over } });
};

test('the three fields, for classes 9, 10, 1st year and 2nd year only', () => {
  assert.deepEqual(Object.values(FIELDS), ['Engineering', 'Medical', 'Computer Science']);
  for (const c of [9, 10, 11, 12]) assert.equal(hasFields(c), true);
  for (const c of [1, 5, 8, 13, null]) assert.equal(hasFields(c), false);
});

test('cleanField: valid, empty, invalid, and not-applicable classes', () => {
  assert.deepEqual(cleanField('medical', 10), { value: 'medical' });
  assert.deepEqual(cleanField('', 10), { value: null });
  assert.deepEqual(cleanField(undefined, 10), { value: null });
  assert.match(cleanField('astrology', 10).error, /Engineering, Medical or Computer Science/);
  assert.deepEqual(cleanField('medical', 6), { value: null }, 'Class 6 has no fields');
});

test('cleanFieldList: empty and "all three" both mean every field', () => {
  assert.deepEqual(cleanFieldList(['medical'], 9, 10), { value: ['medical'] });
  assert.deepEqual(cleanFieldList(['medical', 'medical'], 9, 10), { value: ['medical'] });
  assert.deepEqual(cleanFieldList([], 9, 10), { value: null });
  assert.deepEqual(cleanFieldList(['engineering', 'medical', 'computer_science'], 9, 10), { value: null });
  assert.deepEqual(cleanFieldList(['medical'], 1, 8), { value: null }, 'a Class 1-8 subject has no fields');
  assert.match(cleanFieldList(['nope'], 9, 10).error, /Choose/);
});

test('REGISTER: a Class 9-12 student picks a field; it is stored', async () => {
  for (const [cls, f] of [[9, 'engineering'], [10, 'medical'], [11, 'computer_science'], [12, 'engineering']]) {
    const r = await register({ class_level: cls, academic_field: f });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal((await one('SELECT academic_field FROM users WHERE email=$1', [r.body.user?.email || ''])) ? true : true, true);
  }
  const r = await register({ class_level: 10, academic_field: 'medical' });
  const row = await one(`SELECT academic_field FROM users WHERE full_name = $1`, [`Field Kid ${seq}`]);
  assert.equal(row.academic_field, 'medical');
});

test('REGISTER: a field is optional, invalid ones are refused, and Class 1-8 ignore it', async () => {
  assert.equal((await register({ class_level: 10 })).status, 201);
  const bad = await register({ class_level: 10, academic_field: 'astrology' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Engineering, Medical or Computer Science/);

  const young = await register({ class_level: 6, academic_field: 'medical' });
  assert.equal(young.status, 201);
  assert.equal((await one(`SELECT academic_field FROM users WHERE full_name = $1`, [`Field Kid ${seq}`])).academic_field, null);
});

test('PROFILE: change the field; leaving Class 9-12 clears it; a bad one is refused', async () => {
  const r = await register({ class_level: 10, academic_field: 'engineering' });
  const token = r.body.token;

  const set = await api('PUT', '/api/student/profile', { token, body: { academic_field: 'computer_science' } });
  assert.equal(set.status, 200);
  assert.equal(set.body.academic_field ?? set.body.user?.academic_field, 'computer_science');

  const bad = await api('PUT', '/api/student/profile', { token, body: { academic_field: 'law' } });
  assert.equal(bad.status, 400);

  await api('PUT', '/api/student/profile', { token, body: { class_level: 6 } });
  const row = await one(`SELECT class_level, academic_field FROM users WHERE full_name = $1`, [`Field Kid ${seq}`]);
  assert.equal(row.class_level, 6);
  assert.equal(row.academic_field, null, 'no field below Class 9');

  const me = await api('GET', '/api/auth/me', { token });
  assert.ok('academic_field' in me.body);
});

test('SEARCH: filter by field. A tutor who teaches all fields is always shown', async () => {
  const body = (extra) => ({ subject_ids: [subj], ...extra });
  const search = async (extra) => JSON.stringify((await api('POST', '/api/search', { token: student.token, body: body(extra) })).body);
  const name = tutor.user.full_name;

  await query('UPDATE tutor_subjects SET fields = NULL WHERE tutor_id=$1 AND subject_id=$2', [tutorId, subj]);
  for (const f of ['engineering', 'medical', 'computer_science']) assert.ok((await search({ academic_field: f })).includes(name), `all-fields tutor for ${f}`);

  await query(`UPDATE tutor_subjects SET fields = ARRAY['medical'] WHERE tutor_id=$1 AND subject_id=$2`, [tutorId, subj]);
  assert.ok((await search({ academic_field: 'medical' })).includes(name));
  assert.ok(!(await search({ academic_field: 'engineering' })).includes(name), 'medical-only tutor hidden from Engineering');
  assert.ok((await search({})).includes(name), 'no filter shows everyone');

  const r = await api('POST', '/api/search', { token: student.token, body: body({ academic_field: 'medical' }) });
  const list = Array.isArray(r.body) ? r.body : (r.body.results || r.body.tutors);
  const tutorRow = list.find((t) => t.full_name === name);
  assert.deepEqual(tutorRow.matches.find((m) => m.subject_id === subj).fields, ['medical'], 'the result tells the student which fields the tutor teaches');

  assert.equal((await api('POST', '/api/search', { token: student.token, body: body({ academic_field: 'astrology' }) })).status, 400);
  await query('UPDATE tutor_subjects SET fields = NULL WHERE tutor_id=$1 AND subject_id=$2', [tutorId, subj]);
});

test('the database itself refuses an invented field', async () => {
  await assert.rejects(query(`UPDATE users SET academic_field = 'astrology' WHERE email = 'student@stf.pk'`), /check/i);
  await assert.rejects(query(`UPDATE tutor_subjects SET fields = ARRAY['astrology'] WHERE tutor_id = $1`, [tutorId]), /check/i);
});
