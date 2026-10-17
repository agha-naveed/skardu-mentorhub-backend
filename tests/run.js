// ============================================================
// npm test
// ============================================================
// Rebuilds a THROWAWAY database, then runs every test file against
// the real server and real PostgreSQL. It refuses to touch any
// database whose name does not contain "test", because setup.js
// DROPS every table.
//
//   TEST_DATABASE_URL=postgres://user:pw@localhost:5432/stf_test npm test
// ============================================================
import { spawnSync } from 'child_process';

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.error('Set TEST_DATABASE_URL to an EMPTY test database, e.g.\n' +
    '  TEST_DATABASE_URL=postgres://postgres:pw@localhost:5432/stf_test npm test');
  process.exit(1);
}
if (!/test/i.test(new URL(url).pathname)) {
  console.error('Refusing to run: the database name must contain "test" (setup drops all tables).');
  process.exit(1);
}

const env = {
  ...process.env,
  NODE_ENV: 'test',
  DATABASE_URL: url,
  JWT_SECRET: process.env.JWT_SECRET || 'test-secret-test-secret-test-secret-123456',
};

console.log('Building the test database...');
let r = spawnSync('node', ['setup.js'], { env, stdio: ['ignore', 'ignore', 'inherit'] });
if (r.status !== 0) process.exit(r.status || 1);

// `npm test` runs everything; `npm test -- tests/videos.test.js` runs one file.
const only = process.argv.slice(2);
r = spawnSync('node', ['--test', '--test-concurrency=1', ...(only.length ? only : ['tests/*.test.js'])], { env, stdio: 'inherit' });
process.exit(r.status ?? 1);
