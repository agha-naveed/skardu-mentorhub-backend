// Generates docs/ER.md from the LIVE database, so the diagram can never
// disagree with the real schema.
//   DATABASE_URL=... node scripts/er.mjs
import fs from 'fs';
import { query, pool } from '../db.js';

const cols = await query(`
  SELECT c.table_name, c.column_name, c.data_type, c.is_nullable, c.ordinal_position
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
   WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
   ORDER BY c.table_name, c.ordinal_position`);
const pks = await query(`
  SELECT tc.table_name, kcu.column_name FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
   WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'`);
const fks = await query(`
  SELECT tc.table_name, kcu.column_name, ccu.table_name AS ref_table
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
    JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
   WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
   ORDER BY tc.table_name`);

const pk = new Set(pks.map((r) => `${r.table_name}.${r.column_name}`));
const fk = new Set(fks.map((r) => `${r.table_name}.${r.column_name}`));
const type = (t) => t.replace('timestamp with time zone', 'timestamptz').replace('character varying', 'varchar')
  .replace('timestamp without time zone', 'timestamp').replace(/\s/g, '_');

const byTable = new Map();
for (const c of cols) { if (!byTable.has(c.table_name)) byTable.set(c.table_name, []); byTable.get(c.table_name).push(c); }

const GROUPS = {
  'Accounts and tutors': ['users', 'tutors', 'tutor_subjects', 'tutor_availability', 'subjects', 'reviews', 'reports', 'report_reasons', 'tutor_changes', 'password_resets'],
  'Enrollment and chat': ['enrollments', 'enrollment_subjects', 'messages', 'announcements', 'announcement_reads', 'notifications', 'device_tokens', 'notification_prefs'],
  'Classes and assignments': ['class_sessions', 'class_session_students', 'attendance', 'assignments', 'assignment_students', 'assignment_submissions'],
  'Exams': ['quizzes', 'quiz_questions', 'quiz_options', 'quiz_releases', 'quiz_attempts', 'quiz_answers', 'exam_cheat_events'],
  'Videos': ['videos', 'video_releases'],
  'Payments and settings': ['payments', 'app_settings'],
  'Audit': ['activity_log'],
};

let md = `# Entity-relationship diagram\n\n_Generated from the live database by \`node scripts/er.mjs\` — ${byTable.size} tables._\n\n`;
md += 'Each box lists every column. `PK` primary key, `FK` foreign key.\n\n';

const all = [...byTable.keys()];
const listed = new Set(Object.values(GROUPS).flat());
const other = all.filter((t) => !listed.has(t));
if (other.length) GROUPS.Other = other;

for (const [group, tables] of Object.entries(GROUPS)) {
  const present = tables.filter((t) => byTable.has(t));
  if (!present.length) continue;
  md += `## ${group}\n\n\`\`\`mermaid\nerDiagram\n`;
  for (const t of present) {
    md += `  ${t} {\n`;
    for (const c of byTable.get(t)) {
      const tag = pk.has(`${t}.${c.column_name}`) ? ' PK' : fk.has(`${t}.${c.column_name}`) ? ' FK' : '';
      md += `    ${type(c.data_type)} ${c.column_name}${tag}\n`;
    }
    md += '  }\n';
  }
  const seen = new Set();
  for (const r of fks) {
    if (!present.includes(r.table_name)) continue;
    const key = `${r.ref_table}>${r.table_name}`;
    if (seen.has(key)) continue; seen.add(key);
    if (!present.includes(r.ref_table)) { md += `  ${r.ref_table} ||--o{ ${r.table_name} : has\n`; }
    else md += `  ${r.ref_table} ||--o{ ${r.table_name} : has\n`;
  }
  md += '```\n\n';
}

fs.writeFileSync('docs/ER.md', md);
console.log(`docs/ER.md written (${byTable.size} tables, ${fks.length} foreign keys)`);
await pool.end();
