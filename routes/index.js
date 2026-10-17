// ============================================================
// Every route file, mounted in one place
// ============================================================
// server.js keeps the original routes (auth, tutors, search,
// enrollments, videos, ...). Everything added later lives in its
// own file under routes/ and is listed here.
// ============================================================
import { router as passwordReset } from './passwordReset.js';
import { router as exams } from './exams.js';
import { router as devices } from './devices.js';
import { router as schedule } from './schedule.js';
import { router as assignments } from './assignments.js';
import { router as payments } from './payments.js';
import { router as chat } from './chat.js';
import { router as analytics } from './analytics.js';
import { router as audit } from './audit.js';
import { router as videos } from './videos.js';
import { router as areas } from './areas.js';

export function mountRoutes(app) {
  app.use(passwordReset);
  app.use(exams);
  app.use(devices);
  app.use(schedule);
  app.use(assignments);
  app.use(payments);
  app.use(chat);
  app.use(analytics);
  app.use(audit);
  app.use(videos);
  app.use(areas);
}
