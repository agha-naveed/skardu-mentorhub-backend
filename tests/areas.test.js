import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, shutdown, api, login, query, one } from './helpers.js';

let admin, student, tutor, tlat, tlng, subj;
before(async () => {
  await boot();
  admin = await login('admin@stf.pk'); student = await login('student@stf.pk'); tutor = await login('tutor@stf.pk');
  const t = await one('SELECT latitude::float AS lat, longitude::float AS lng FROM tutors WHERE id=$1', [tutor.user.tutor.id]);
  tlat = t.lat; tlng = t.lng; subj = tutor.user.tutor.subjects[0].subject_id;
  await query('DELETE FROM coverage_areas');
});
after(shutdown);

const box = (lat, lng, d = 0.02) => [[lat - d, lng - d], [lat - d, lng + d], [lat + d, lng + d], [lat + d, lng - d]];
const create = (name, polygon, token = admin.token) => api('POST', '/api/admin/areas', { token, body: { name, polygon } });
const found = async (extra) => JSON.stringify((await api('POST', '/api/search', { token: student.token, body: { subject_ids: [subj], ...extra } })).body).includes(tutor.user.full_name);

test('the tutor really has a pinned location to test with', () => {
  assert.ok(Number.isFinite(tlat) && Number.isFinite(tlng));
});

test('draw an area: stored, centre worked out, tutors inside counted, audited', async () => {
  const r = await create('Around the tutor', box(tlat, tlng));
  assert.equal(r.status, 201);
  const list = await api('GET', '/api/admin/areas', { token: admin.token });
  const a = list.body.areas.find((x) => x.name === 'Around the tutor');
  assert.equal(a.polygon.length, 4);
  assert.ok(Math.abs(a.center_lat - tlat) < 0.001 && Math.abs(a.center_lng - tlng) < 0.001);
  assert.ok(a.tutors >= 1, 'the tutor is inside');
  assert.ok((await query(`SELECT 1 FROM activity_log WHERE action='area_created'`)).length);
});

test('validation: corners, coordinates, a straight line, name, duplicates', async () => {
  assert.equal((await create('Two', [[1, 1], [2, 2]])).status, 400);
  assert.equal((await create('Bad', [[1, 1], [2, 2], ['x', 3]])).status, 400);
  assert.equal((await create('Off earth', [[95, 1], [2, 2], [3, 3]])).status, 400);
  assert.match((await create('Line', [[1, 1], [2, 2], [3, 3]])).body.error, /straight line/);
  assert.equal((await create('  ', box(1, 1))).status, 400);
  assert.equal((await create('AROUND THE TUTOR', box(tlat, tlng))).status, 409, 'names are unique, ignoring case');
  assert.equal((await api('POST', '/api/admin/areas', { token: admin.token, body: { name: 'Nothing' } })).status, 400);
  assert.equal((await create('Huge', Array.from({ length: 501 }, (_, i) => [i / 100, (i % 7) / 10 + i / 1000]))).status, 400);
});

test('only the administrator can draw, change or delete', async () => {
  assert.equal((await create('Sneaky', box(1, 1), student.token)).status, 403);
  assert.equal((await create('Sneaky', box(1, 1), tutor.token)).status, 403);
  assert.equal((await api('POST', '/api/admin/areas', { body: {} })).status, 401);
  assert.equal((await api('DELETE', '/api/admin/areas/00000000-0000-0000-0000-000000000000', { token: student.token })).status, 403);
  assert.equal((await api('PUT', '/api/admin/features', { token: tutor.token, body: { coverage_areas: false } })).status, 403);
});

test('SEARCH inside an area: tutors in the boundary are shown, others are not', async () => {
  const near = (await api('GET', '/api/areas', { token: student.token })).body.areas.find((a) => a.name === 'Around the tutor');
  const far = await create('Far away', box(tlat + 5, tlng + 5));
  assert.equal(far.status, 201);

  assert.equal(await found({}), true, 'no area chosen shows everybody');
  assert.equal(await found({ area_id: near.id }), true, 'inside');
  assert.equal(await found({ area_id: far.body.id }), false, 'outside');
  assert.equal((await api('POST', '/api/search', { token: student.token, body: { subject_ids: [subj], area_id: '00000000-0000-0000-0000-000000000000' } })).status, 400);
  assert.equal((await api('POST', '/api/search', { token: student.token, body: { subject_ids: [subj], area_id: 'nonsense' } })).status, 400);
});

test('an irregular (L-shaped) boundary is respected, not just its bounding box', async () => {
  // an L that EXCLUDES the tutor's corner of the bounding box
  const d = 0.04;
  const L = [[tlat - d, tlng - d], [tlat - d, tlng + d], [tlat - d / 4, tlng + d], [tlat - d / 4, tlng - d / 4], [tlat + d, tlng - d / 4], [tlat + d, tlng - d]];
  // the tutor sits at (tlat, tlng): inside the notch (the empty corner)
  const r = await create('L shape', L);
  assert.equal(r.status, 201);
  assert.equal(await found({ area_id: r.body.id }), false, 'inside the bounding box but outside the L');
  const put = await api('PUT', `/api/admin/areas/${r.body.id}`, { token: admin.token, body: { name: 'L shape', polygon: box(tlat, tlng, 0.01) } });
  assert.equal(put.status, 200);
  assert.equal(await found({ area_id: r.body.id }), true, 'after redrawing around the tutor');
});

test('edit and delete', async () => {
  const a = (await create('Temp', box(tlat, tlng))).body;
  assert.equal((await api('PUT', `/api/admin/areas/${a.id}`, { token: admin.token, body: { name: 'Around the tutor', polygon: box(1, 1) } })).status, 409, 'rename to an existing name');
  assert.equal((await api('PUT', `/api/admin/areas/${a.id}`, { token: admin.token, body: { name: 'Temp 2', polygon: box(1, 1) } })).status, 200);
  assert.equal((await api('DELETE', `/api/admin/areas/${a.id}`, { token: admin.token })).status, 200);
  assert.equal((await api('DELETE', `/api/admin/areas/${a.id}`, { token: admin.token })).status, 404);
  assert.equal((await api('PUT', '/api/admin/areas/nope', { token: admin.token, body: {} })).status, 404);
  const acts = (await query('SELECT DISTINCT action FROM activity_log')).map((r) => r.action);
  for (const x of ['area_created', 'area_changed', 'area_deleted']) assert.ok(acts.includes(x), x);
});

test('the SWITCH hides the filter from students without deleting anything', async () => {
  const before = (await api('GET', '/api/areas', { token: student.token })).body;
  assert.equal(before.enabled, true); assert.ok(before.areas.length >= 1);

  assert.equal((await api('PUT', '/api/admin/features', { token: admin.token, body: { coverage_areas: false } })).status, 200);
  const hidden = (await api('GET', '/api/areas', { token: student.token })).body;
  assert.deepEqual(hidden, { enabled: false, areas: [] });
  assert.ok((await api('GET', '/api/admin/areas', { token: admin.token })).body.areas.length >= 1, 'the admin still has every area');

  assert.equal((await api('PUT', '/api/admin/features', { token: admin.token, body: { coverage_areas: 'yes' } })).status, 400);
  await api('PUT', '/api/admin/features', { token: admin.token, body: { coverage_areas: true } });
  assert.equal((await api('GET', '/api/areas', { token: student.token })).body.enabled, true);
});
