import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, shutdown, api, login, query } from './helpers.js';

let admin, tutor;
before(async () => { await boot(); admin = await login('admin@stf.pk'); tutor = await login('tutor@stf.pk'); });
after(shutdown);

test('admin can search and filter by user, role, action and date', async () => {
  await api('POST', '/api/auth/login', { body: { email: 'tutor@stf.pk', password: 'nope-nope' } });
  const all = await api('GET', '/api/admin/audit', { token: admin.token });
  assert.equal(all.status, 200);
  assert.ok(all.body.total >= 3 && all.body.entries.length);
  const e = all.body.entries[0];
  assert.ok('user_name' in e && 'user_role' in e && 'action' in e && 'detail' in e && 'created_at' in e);

  const byAction = await api('GET', '/api/admin/audit?action=login_failed', { token: admin.token });
  assert.ok(byAction.body.entries.length && byAction.body.entries.every((x) => x.action === 'login_failed'));
  const byRole = await api('GET', '/api/admin/audit?role=admin', { token: admin.token });
  assert.ok(byRole.body.entries.every((x) => x.user_role === 'admin'));
  const byUser = await api('GET', '/api/admin/audit?user=Ali', { token: admin.token });
  assert.ok(byUser.body.entries.every((x) => /ali/i.test(x.user_name)));
  const today = new Date().toISOString().slice(0, 10);
  assert.ok((await api('GET', `/api/admin/audit?from=${today}&to=${today}`, { token: admin.token })).body.total >= 1);
  assert.equal((await api('GET', '/api/admin/audit?from=1999-01-01&to=1999-01-02', { token: admin.token })).body.total, 0);
  assert.equal((await api('GET', '/api/admin/audit?from=yesterday', { token: admin.token })).status, 400);
  const page = await api('GET', '/api/admin/audit?limit=2&offset=1', { token: admin.token });
  assert.equal(page.body.entries.length, 2);
  assert.ok((await api('GET', '/api/admin/audit/actions', { token: admin.token })).body.includes('login'));
});

test('SQL in filters is harmless', async () => {
  const r = await api('GET', `/api/admin/audit?user=${encodeURIComponent("x'; DROP TABLE activity_log;--")}`, { token: admin.token });
  assert.equal(r.status, 200);
  assert.ok((await query('SELECT COUNT(*)::int AS n FROM activity_log'))[0].n > 0);
});

test('only admins read it; nobody can change or delete an entry', async () => {
  assert.equal((await api('GET', '/api/admin/audit', { token: tutor.token })).status, 403);
  assert.equal((await api('GET', '/api/admin/audit')).status, 401);
  for (const m of ['PUT', 'PATCH', 'DELETE', 'POST']) assert.equal((await api(m, '/api/admin/audit/1', { token: admin.token, body: {} })).status, 404);
  await assert.rejects(query(`UPDATE activity_log SET detail = 'tampered' WHERE id = (SELECT MAX(id) FROM activity_log)`), /read-only/);
  await assert.rejects(query(`DELETE FROM activity_log`), /read-only/);
});

test('the key events are all in the log', async () => {
  const have = new Set((await query('SELECT DISTINCT action FROM activity_log')).map((r) => r.action));
  for (const a of ['login', 'login_failed']) assert.ok(have.has(a), `missing ${a}`);
});
