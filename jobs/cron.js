// ============================================================
// Scheduled jobs
// ============================================================
//   every 30 s   finish exams whose time ran out (anti-"close the app")
//   every minute class reminders (30 min before), assignment reminders
//   daily 00:10  monthly payment cycle: reminders, then suspension
//                on the due day — Pakistan time
//   at start-up  the payment cycle once, to catch up if the server
//                was down at 00:10
//
// Every job is safe to run twice or on two servers at once (each
// claims its work with an atomic UPDATE), and one job failing never
// stops another.
// ============================================================
import cron from 'node-cron';
import { sweepExpiredAttempts } from '../routes/exams.js';
import { sendClassReminders } from '../routes/schedule.js';
import { sendAssignmentReminders } from '../routes/assignments.js';
import { runMonthlyCycle } from '../routes/payments.js';

const running = new Set();

function guarded(name, fn) {
  return async () => {
    if (running.has(name)) return;         // previous run still going
    running.add(name);
    try {
      await fn();
    } catch (err) {
      console.error(`[job ${name}]`, err.message);
    } finally {
      running.delete(name);
    }
  };
}

export function startJobs() {
  const tz = 'Asia/Karachi';
  const tasks = [
    cron.schedule('*/30 * * * * *', guarded('exams', sweepExpiredAttempts)),
    cron.schedule('* * * * *', guarded('class-reminders', sendClassReminders)),
    cron.schedule('* * * * *', guarded('assignment-reminders', sendAssignmentReminders)),
    cron.schedule('10 0 * * *', guarded('monthly-cycle', runMonthlyCycle), { timezone: tz }),
  ];
  guarded('monthly-cycle', runMonthlyCycle)();
  console.log('Scheduled jobs running');
  return () => tasks.forEach((t) => t.stop());
}
