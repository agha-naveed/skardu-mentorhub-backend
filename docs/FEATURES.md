# Feature map

Every item in the feature list, where it lives, and what proves it works.

| # | Feature | Server | App | Tests |
|---|---|---|---|---|
| 1 | Accounts, JWT, bcrypt, rate limit, terms, validation, profile picture, suspend/restore | `server.js` | Login, Register, StudentProfile, AdminStudents/Tutors | `regression`, `devices` (failed-login audit) |
| 2 | Forgot password by WhatsApp OTP | `routes/passwordReset.js`, `lib/whatsapp.js` (Baileys) | `ForgotPassword.jsx` | `passwordReset` (14), `whatsapp` (13), app e2e |
| 3 | Tutor onboarding & verification | `server.js` | Register, AdminTutors/Changes | `regression`, `payments` |
| 4 | Search, compare, reviews, reports, unpaid removed from search | `server.js`, `routes/payments.js` | Search, TutorDetail, Compare | `regression`, `payments` |
| 5 | Enrollment | `server.js` | Enrollments, TutorRequests | `regression` |
| 6 | Notifications: Socket.IO, FCM push, tokens, tap-to-open, Alerts, badges, no polling, preferences | `helpers.js notify`, `lib/push.js`, `routes/devices.js` | `push.js`, `usePoll.js`, `Alerts.jsx`, `NotificationSettings.jsx` | `devices`, `chat` |
| 7 | Chat: 1-to-1, announcements, typing, unread, images, seen/read receipts | `server.js`, `routes/chat.js`, `socket.js` | `Chat.jsx` | `chat` (7) |
| 8 | Class schedule, 30-min reminder, cancel/reschedule, attendance in/out | `routes/schedule.js` | StudentSchedule, TutorSchedule | `schedule` (11) |
| 9 | Assignments: create, submit, late block/flag, mark + feedback, reminders | `routes/assignments.js` | StudentAssignments, TutorAssignments | `assignments` (10) |
| 10 | MCQ exams, 15 s/question server-enforced, auto-advance, anti-cheat | `routes/exams.js` | `QuizTake.jsx`, TutorQuizzes, AdminExams | `exams` (19), app e2e |
| 11 | Analytics: student, tutor (per student/class), admin; charts | `routes/analytics.js` | StudentProgress, TutorAnalytics, AdminAnalytics (Recharts) | `analytics` (5) |
| 12 | Videos (Cloudinary), release dates, announcements + read tracking | `server.js`, `cloudinary.js` | Videos, Announcements | `regression` |
| 13 | Payments: details on screen, receipt, admin verify/reject, monthly cycle, history, filters | `routes/payments.js`, `subscription.js` | TutorPayment, AdminPayments, AdminPaymentSettings | `payments` (13) |
| 14 | Audit log: everything recorded, filterable, read-only | `helpers.js logActivity`, `routes/audit.js`, DB trigger | AdminAudit | `audit` (4) |
| 15 | Admin panel | `server.js` + above | AdminDashboard and sub-screens | `regression` |
| 16 | Platform & security: offline banner, back button, reconnecting socket, server URL, Helmet, CORS, mandatory secret, https, tests, docs, ER, deployment | `lib/env.js`, `server.js` | `App.jsx`, `useBackButton.js`, `config.js` | `devices`, all; this folder |
| 17 | Tech stack | as specified | as specified | — |

## Added in this version

| Feature | Server | App | Tests |
|---|---|---|---|
| Academic field (Engineering / Medical / Computer Science) for Class 9, 10, 1st and 2nd year: register, profile, tutor subjects, search | `lib/fields.js`, `server.js`, `migrate_v3.sql` | Register, StudentProfileEdit, TutorProfileEdit, StudentSearch, `FieldChips` | `fields` (8), app e2e |
| Share a video: the video decides subject/class/field; who is eligible and why not | `routes/videos.js` | TutorVideos (Share tab) | `videos` (12), app e2e |
| Watch history: real minutes, per sitting, how far | `routes/videos.js`, `video_watch_sessions` | `VideoPlayer`, StudentVideos, TutorVideos | `videos`, app e2e |
| Coverage areas drawn on a map; search inside an area; on/off switch | `routes/areas.js`, `point_in_polygon()` | AdminAreas, `AreaDrawer`, `AreaPicker` | `areas` (8), app e2e |
| Online classes: free video room, one-tap Join that records attendance | `routes/schedule.js` | StudentSchedule, TutorSchedule | `online` (7), app e2e |
| Notifications that ring (closed app, screen off) | `lib/push.js` | `push.js`, `native.js`, `scripts/android-manifest.mjs` | `online`, app e2e |

Generated references: [`API.md`](API.md), [`ER.md`](ER.md).
