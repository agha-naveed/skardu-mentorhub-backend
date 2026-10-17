// ============================================================
// Talking to PostgreSQL
// ============================================================
// A thin wrapper over the `pg` driver. Two helpers cover every
// query in this project:
//
//   query(sql, values)  -> all matching rows
//   one(sql, values)    -> the first row, or null
//
// Values are ALWAYS passed separately as $1, $2 and so on. They
// are never glued into the SQL string, because that is exactly
// how SQL injection happens.
// ============================================================

import pg from 'pg';
import 'dotenv/config';

// Catch the two most common set-up mistakes with a sentence a person
// can act on, instead of a wall of "getaddrinfo ENOTFOUND host".
const dbUrl = process.env.DATABASE_URL || '';
if (!dbUrl) {
  throw new Error(
    'DATABASE_URL is not set. Open server/.env and add your PostgreSQL address, e.g.\n' +
    '  DATABASE_URL=postgres://postgres:YOURPASSWORD@localhost:5432/stf'
  );
}
if (/@host(:|\/|$)/i.test(dbUrl) || /user:password@|YOURPASSWORD|dbname$/i.test(dbUrl)) {
  throw new Error(
    'DATABASE_URL is still the example from .env.example ("host", "user", "password").\n' +
    '  Open server/.env and put your real PostgreSQL details, e.g.\n' +
    '  DATABASE_URL=postgres://postgres:YOURPASSWORD@localhost:5432/stf\n' +
    '  (and create that database first: psql -U postgres -c "CREATE DATABASE stf;")'
  );
}

// A DATE column (no time of day) must stay a plain 'YYYY-MM-DD'
// string. The driver's default turns it into a JavaScript Date at
// local midnight, which shifts by a day when the server and the
// database disagree about the time zone.
pg.types.setTypeParser(1082, (value) => value);

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

export async function query(sql, values = []) {
  const result = await pool.query(sql, values);
  return result.rows;
}

export async function one(sql, values = []) {
  const rows = await query(sql, values);
  return rows[0] || null;
}

export { pool };
