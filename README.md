# Smart Tutor Finder — server

Node 20+, Express 4, Socket.IO 4, PostgreSQL.

## Run it

```bash
npm install
cp .env.example .env          # fill in DATABASE_URL and JWT_SECRET
npm run db:setup              # DEV ONLY: drops every table, rebuilds, adds demo accounts
npm start
```

Demo accounts (password `password123`): `admin@stf.pk`, `student@stf.pk`, `student2@stf.pk`,
`tutor@stf.pk`, `tutor2@stf.pk`, `tutor3@stf.pk`.

**Never run `db:setup` against real data — it deletes everything.** To bring an existing
database up to date without losing anything, run `npm run db:migrate`; it only adds what is
missing and can be run any number of times.

## Tests

```bash
TEST_DATABASE_URL=postgres://postgres:pw@localhost:5432/stf_test npm test
```

Needs an EMPTY database whose name contains `test` (the runner refuses any other — it drops all tables).
It starts the real server and talks to real PostgreSQL: 148 tests covering sign-in, OTP reset, exams and
anti-cheat, schedule and attendance, assignments, payments and the monthly cycle, chat, analytics,
audit log, push, security headers, fields, video sharing and watch history, coverage areas, online classes, and a regression pass over the original routes.

## How the server is organised

| Where | What |
|---|---|
| `server.js` | Original routes (accounts, tutors, search, enrollment, videos, quizzes, chat, announcements, admin) plus start-up and shutdown |
| `routes/` | Everything added since, one file per feature: `passwordReset`, `exams`, `schedule`, `assignments`, `payments`, `chat`, `analytics`, `audit`, `devices`, `videos`, `areas` |
| `jobs/cron.js` | Scheduler (see below) |
| `lib/` | Config (`env`), WhatsApp (Baileys), push, media uploads, shared helpers |
| `schema.sql` → `migrate.sql` → `migrate_v2.sql` → `migrate_v3.sql` | The database, applied in that order (`lib/migrations.js`) |
| `docs/API.md`, `docs/ER.md` | Generated: `npm run docs` |

## Scheduled jobs (node-cron, Pakistan time)

| When | What |
|---|---|
| every 30 s | Finish exams whose time ran out, so closing the app does not stop the clock |
| every minute | Class reminder 30 min before; assignment reminder 24 h before the deadline |
| daily 00:10, and once at start-up | Monthly payment cycle |

Every job claims its work with an atomic update, so running two server instances will not send anything twice.

## Monthly payments

A verified payment covers a **calendar month**. Payment is due by the **3rd** (admin can change the day).
On the due day any approved tutor whose month is not **verified** is suspended automatically and removed
from search. They can still sign in and send a receipt; verification restores them immediately. A newly
approved tutor is covered for the rest of that month. Reminders go out once a day before the due day.
"Today" is always Pakistan time.

## Forgot password (WhatsApp, through Baileys)

Baileys is an **unofficial** WhatsApp Web client. The server links to one WhatsApp account as a
*linked device* (the same way WhatsApp Web does) and sends the reset code from it.

**Turn it on and link the account (once)**

1. Set `WHATSAPP_ENABLED=1` and start the server.
2. Either scan the QR printed in the server log (*WhatsApp → Settings → Linked devices → Link a device*), **or**
   set `WHATSAPP_PAIRING_NUMBER=923001234567` (the number that will send the codes) and type the
   8-character code the log prints under *Link with phone number instead*. The code route is easier on a
   host where you only see logs.
3. The log says `[whatsapp] Connected`. The session is saved in `WHATSAPP_AUTH_DIR` (default `./wa-auth`,
   git-ignored), so later restarts reconnect on their own.

**Things you must know**

* **Use a dedicated number**, not a personal one. WhatsApp can restrict or ban numbers that use unofficial
  clients, and a banned number cannot be recovered. This server only ever sends reset codes, one at a time with
  a short random pause, to numbers that exist on WhatsApp, and the reset routes already cap how many codes anyone
  can request — that keeps volume low, but it does not make the risk zero.
* **Keep `wa-auth/` on a persistent disk.** If it is wiped (Render's free tier does this on every deploy) you
  must link again each time.
* **Run one server instance.** Two instances sharing a session knock each other off.
* If someone removes the device from the phone, the saved session is deleted and a new QR / code is printed.
* While WhatsApp is disconnected, reset requests still answer normally (the answer never reveals whether a
  number is registered) but no code is delivered; the failure is logged. Watch for `[whatsapp]` lines.

The code rules are unchanged: 6 digits, stored hashed, valid 5 minutes, single use, 5 attempts, 60 s resend
wait, 5 codes/hour per phone and 10/hour per IP.

## Push notifications (Firebase) — they ring

When the app is **closed or the screen is off**, Android shows the notification itself, and it rings like any
other app. That needs all four of these:

1. **Firebase key on the server.** Firebase console → Project settings → Service accounts → *Generate new
   private key*. Save it as `server/firebase-key.json` (or put the JSON on one line in `FIREBASE_SERVICE_ACCOUNT`).
2. **`google-services.json` in the app** (`app/android/app/`), from the same Firebase project, for the Android app
   `pk.skardu.smarttutorfinder`.
3. **The server must be running.** Class reminders (30 min before) and assignment reminders are sent by the
   server's scheduler. A host that puts the server to sleep when idle (Render's free tier does) will **not** send
   them on time. Use a plan that stays awake, or an external pinger.
4. **Android 13+ permission** — the app asks once after the first sign-in (the normal system dialog).

What makes it ring is set on both sides: the server sends every push as *high priority* with the phone's own
sound, vibration and lock-screen visibility, on a loud notification channel; the app creates that channel when it
starts. If you change the channel's settings later on a phone that already ran the app, **uninstall the app
first** — Android remembers a channel's importance and will not raise it.

Some phone makers (Xiaomi/MIUI, Oppo, Vivo, Huawei) kill background apps aggressively. If notifications arrive
only when the app is open, the phone's *battery / autostart* setting for the app is the cause, not this code.

## Fields, areas and videos

* **Fields.** Students in Class 9, 10, 1st year and 2nd year (11, 12) choose Engineering, Medical or Computer
  Science. A tutor ticks the fields they teach each subject for (empty = all). Search can filter by field; a tutor
  who teaches all fields is always shown. Stored as `users.academic_field`, `tutor_subjects.fields`,
  `videos.academic_field`; the database refuses any other value.
* **Coverage areas.** The administrator draws a named boundary on a map (`/admin/areas`). A student can search
  inside it; a tutor is "in" when their pinned location is inside. A switch hides the filter from students without
  deleting anything. The test is `point_in_polygon` in the database and the app uses the same maths.
* **Sharing videos.** A video already has its subject, class range and field, so the Share screen does not ask
  again. The server works out who is eligible and tells the tutor *why* anyone is left out (attends in person, not
  enrolled in that subject, wrong class, different field).
* **Watch history.** The lesson plays inside the app. It reports real playing time every ~10 s; every sitting is a
  row. A report can never credit more than the real time that passed on the server's clock. Links that cannot report
  playback (a Drive link) are counted as "open" time and labelled that way.

## Deploying

* **Database:** Neon or Supabase — copy the connection string into `DATABASE_URL` (include `?sslmode=require`).
* **Server:** Render or Railway — build `npm install`, start `npm start`, set the environment variables above and
  `NODE_ENV=production`. The platform terminates HTTPS; the server refuses plain http in production.
* **First deploy:** run `npm run db:migrate` once against the new database, then create your admin account.
  (`db:setup` is for development only.)
* **Uploaded files** (chat pictures, assignment files, receipts, ID scans) and the **WhatsApp session** (`wa-auth/`) are
  written to the server's disk. Render's free tier wipes that disk on every deploy — attach a **persistent disk** (for `uploads/` and `wa-auth/`), or you will lose them.
* Graceful shutdown on `SIGTERM` is built in, so deploys do not cut requests off mid-write.

## Security notes

Helmet, restricted CORS, no fallback JWT secret, https enforced in production, bcrypt passwords, login
and OTP rate limiting, parameterised SQL everywhere, uploads type-checked by content type and stored under
random names, exam answer key never sent to the phone, audit log protected by a database trigger,
a password change signs out every other device.
