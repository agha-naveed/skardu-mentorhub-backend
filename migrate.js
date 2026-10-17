// ============================================================
// Bringing an older database up to date
// ============================================================
//   node migrate.js
//
// Adds whatever is missing and leaves your data alone. Safe to run
// more than once — the second run finds nothing to do.
//
// This is the one to use when you already have tutors, students
// and enrollments you want to keep. `npm run db:setup` DROPS
// everything and starts again, which is right for a fresh install
// and wrong for yours.
// ============================================================

import fs from 'fs';
import { pool, query } from './db.js';
import { MIGRATION_FILES } from './lib/migrations.js';
import 'dotenv/config';

// The columns the app cannot run without, so the result can be
// checked rather than assumed.
const REQUIRED = [
  ['users', 'learning_modes'],
  ['users', 'avatar'],
  ['tutors', 'teaching_modes'],
  ['tutors', 'subscription_paid_until'],
  ['tutors', 'suspended_until'],
  ['tutors', 'pending_changes'],
  ['enrollments', 'learning_mode'],
  ['enrollments', 'left_at'],
  ['videos', 'source'],
  ['videos', 'cloud_id'],
  ['video_releases', 'watched_seconds'],
  ['quizzes', 'is_published'],
];

const REQUIRED_TABLES = [
  'enrollment_subjects', 'payments', 'videos', 'video_releases',
  'messages', 'announcements', 'announcement_reads',
  'reports', 'activity_log', 'notifications',
  'quizzes', 'quiz_questions', 'quiz_options', 'quiz_releases',
  'quiz_attempts', 'quiz_answers',
];

async function main() {
  console.log('Checking your database...\n');

  const before = await snapshot();

  // The whole file in one transaction, so a failure halfway
  // through leaves the database exactly as it was rather than
  // half-migrated, which is far harder to recover from.
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    for (const file of MIGRATION_FILES) {
      await client.query(fs.readFileSync(`./${file}`, 'utf8'));
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');

    console.error('\nThe migration failed, and nothing was changed.\n');
    console.error(err.message);

    if (err.position) console.error(`  at character ${err.position} of the script`);

    console.error('\nYour database is exactly as it was. If you do not mind');
    console.error('losing the data, "npm run db:setup" rebuilds it from');
    console.error('scratch and will definitely work.\n');

    process.exit(1);
  } finally {
    client.release();
  }

  const after = await snapshot();

  // ---- what actually changed ----
  const newTables = [...after.tables].filter((t) => !before.tables.has(t));
  const newColumns = [...after.columns].filter((c) => !before.columns.has(c));
  const goneColumns = [...before.columns].filter((c) => !after.columns.has(c));

  if (newTables.length === 0 && newColumns.length === 0 && goneColumns.length === 0) {
    console.log('Nothing to do — your database was already up to date.\n');
  } else {
    if (newTables.length) {
      console.log(`Added ${newTables.length} table${newTables.length === 1 ? '' : 's'}:`);
      for (const t of newTables) console.log(`  + ${t}`);
      console.log();
    }

    if (newColumns.length) {
      console.log(`Added ${newColumns.length} column${newColumns.length === 1 ? '' : 's'}:`);
      for (const c of newColumns) console.log(`  + ${c}`);
      console.log();
    }

    if (goneColumns.length) {
      console.log('Replaced:');
      for (const c of goneColumns) console.log(`  - ${c}`);
      console.log();
    }
  }

  // ---- confirm it is actually usable now ----
  const missingColumns = REQUIRED.filter(
    ([table, column]) => !after.columns.has(`${table}.${column}`)
  );
  const missingTables = REQUIRED_TABLES.filter((t) => !after.tables.has(t));

  if (missingColumns.length || missingTables.length) {
    console.error('Still missing after the migration:\n');
    for (const [t, c] of missingColumns) console.error(`  ${t}.${c}`);
    for (const t of missingTables) console.error(`  table ${t}`);
    console.error('\nSomething is off. Send this output and I can look.\n');
    process.exit(1);
  }

  // ---- and report what survived ----
  const counts = await query(`
    SELECT
      (SELECT COUNT(*)::int FROM users)       AS users,
      (SELECT COUNT(*)::int FROM tutors)      AS tutors,
      (SELECT COUNT(*)::int FROM enrollments) AS enrollments
  `);

  const row = counts[0];

  console.log('Your data is intact:');
  console.log(`  ${row.users} users, ${row.tutors} tutors, ${row.enrollments} enrollments`);
  console.log('\nDone. Restart the server.\n');

  await pool.end();
}

// Every table and column, so the before and after can be compared.
async function snapshot() {
  const rows = await query(`
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
  `);

  return {
    tables: new Set(rows.map((r) => r.table_name)),
    columns: new Set(rows.map((r) => `${r.table_name}.${r.column_name}`)),
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
