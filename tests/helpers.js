// Shared by every test file: boots the real server once and gives
// small helpers for calling it.
import { app, start, stop, httpServer } from '../server.js';
import { pool, query, one } from '../db.js';

let base = null;

export async function boot() {
  if (base) return base;
  await start(0);
  base = `http://127.0.0.1:${httpServer.address().port}`;
  return base;
}

export async function shutdown() {
  await stop();
  await pool.end();
  base = null;
}

export async function api(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

export async function login(email, password = 'password123') {
  const r = await api('POST', '/api/auth/login', { body: { email, password } });
  if (r.status !== 200) throw new Error(`login ${email} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return { token: r.body.token, user: r.body.user };
}

export const ACCOUNTS = {
  admin: 'admin@stf.pk',
  student: 'student@stf.pk',
  student2: 'student2@stf.pk',
  tutor: 'tutor@stf.pk',
};

export { query, one, pool, app };
