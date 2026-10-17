// ============================================================
// Live chat
// ============================================================
// Replaces the three-second poll on the chat screen. Polling meant
// a message could sit unseen for three seconds, and it meant every
// open chat hit the database twenty times a minute whether anything
// had happened or not.
//
// Two rules shape this file:
//
//   1. The socket is authenticated the same way every route is —
//      with the JWT. A connection that cannot prove who it is gets
//      refused, not given a guest seat.
//
//   2. A socket can only join a conversation it is ALLOWED in.
//      Room names are guessable, so membership is checked against
//      the enrollment rather than trusted from the client.
//
// The app keeps its polling as a fallback. If the socket cannot
// connect — some networks block websockets — the chat still works,
// just a few seconds behind.
// ============================================================

import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { one, query } from './db.js';
import { tokenPredatesPasswordChange } from './helpers.js';
import { JWT_SECRET as SECRET, corsOrigin } from './lib/env.js';

let io = null;

// A room per conversation. Built from the two ids in a fixed
// order, so both sides compute the same name without having to
// agree on one.
export function roomFor(tutorId, studentId) {
  return `chat:${tutorId}:${studentId}`;
}

// A room per person, for things that are not about one
// conversation — an enrollment answered, a video shared.
export function userRoom(userId) {
  return `user:${userId}`;
}

export function setupSockets(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: corsOrigin },

    // Long-polling is kept as a transport. Some mobile networks
    // and university proxies block websockets outright, and
    // falling back is better than failing.
    transports: ['websocket', 'polling'],

    // A phone that loses signal in a tunnel should not be dropped
    // the moment it comes back.
    pingTimeout: 25000,
    pingInterval: 20000,
  });

  // ---- who is connecting ----
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;

    if (!token) return next(new Error('No token.'));

    let data;
    try {
      data = jwt.verify(token, SECRET);
    } catch {
      return next(new Error('Invalid token.'));
    }

    const user = await one(
      `SELECT id, role, full_name, account_status, password_changed_at FROM users WHERE id = $1`,
      [data.id]
    );

    if (!user) return next(new Error('Account not found.'));
    if (user.account_status === 'suspended') return next(new Error('Account suspended.'));
    if (tokenPredatesPasswordChange(data, user.password_changed_at)) {
      return next(new Error('Session expired.'));
    }

    socket.user = user;

    // A tutor's rows are keyed by their PROFILE id, not their user
    // id, so it is looked up once here rather than on every event.
    if (user.role === 'tutor') {
      const tutor = await one('SELECT id FROM tutors WHERE user_id = $1', [user.id]);
      socket.tutorId = tutor?.id || null;
    }

    next();
  });

  io.on('connection', (socket) => {
    // Their own room, for notifications that are not tied to a
    // conversation.
    socket.join(userRoom(socket.user.id));

    // ---- joining a conversation ----
    // The other side's id is whatever the client says, so it is
    // checked against the enrollment before the socket is let in.
    // Room names are guessable; membership must not be.
    socket.on('chat:join', async (otherId, reply) => {
      const pair = await allowedPair(socket, otherId);

      if (!pair) {
        reply?.({ ok: false, error: 'You cannot open that conversation.' });
        return;
      }

      // Leave any previous one, so a phone moving between chats
      // does not keep receiving the old conversation.
      for (const room of socket.rooms) {
        if (room.startsWith('chat:')) socket.leave(room);
      }

      socket.join(roomFor(pair.tutorId, pair.studentId));
      reply?.({ ok: true });
    });

    socket.on('chat:leave', (otherId) => {
      socket.rooms.forEach((room) => {
        if (room.startsWith('chat:')) socket.leave(room);
      });
    });

    // ---- receipts ----
    // The other side's app tells us a message reached it (ack) or was
    // looked at (read). Both are stored, then echoed to the room so
    // the sender's ticks change live.
    // `otherId` here may be the sender's USER id (that is what the
    // chat:unread event carries), so a student's app can acknowledge
    // without knowing the tutor's tutors.id.
    socket.on('chat:ack', async (otherId, reply) => {
      let pair = await allowedPair(socket, otherId);
      if (!pair && socket.user.role === 'student' && typeof otherId === 'string') {
        const t = await one('SELECT id FROM tutors WHERE user_id::text = $1', [otherId]).catch(() => null);
        if (t) pair = await allowedPair(socket, t.id);
      }
      if (!pair) return reply?.({ ok: false });
      const from = socket.user.role === 'student' ? 'tutor' : 'student';
      const rows = await query(
        `UPDATE messages SET delivered_at = now()
          WHERE tutor_id = $1 AND student_id = $2 AND sender = $3 AND delivered_at IS NULL
          RETURNING id`, [pair.tutorId, pair.studentId, from]);
      if (rows.length) io.to(roomFor(pair.tutorId, pair.studentId)).emit('chat:delivered', { ids: rows.map((r) => r.id), at: new Date() });
      reply?.({ ok: true });
    });

    socket.on('chat:read', async (otherId, reply) => {
      const pair = await allowedPair(socket, otherId);
      if (!pair) return reply?.({ ok: false });
      await markRead(pair, socket.user.role);
      reply?.({ ok: true });
    });

    // ---- typing ----
    // Deliberately NOT stored. It is worth nothing a second later,
    // and writing it to the database twenty times a sentence would
    // be absurd.
    socket.on('chat:typing', async (otherId) => {
      const pair = await allowedPair(socket, otherId);
      if (!pair) return;

      socket.to(roomFor(pair.tutorId, pair.studentId)).emit('chat:typing', {
        from: socket.user.id,
        name: socket.user.full_name,
      });
    });
  });

  console.log('Live chat ready');

  return io;
}

// ------------------------------------------------------------
// May these two talk?
// ------------------------------------------------------------
// The same rule the HTTP routes use: an accepted enrollment, and
// not one the student has left.
// ------------------------------------------------------------
async function allowedPair(socket, otherId) {
  if (!otherId) return null;

  if (socket.user.role === 'student') {
    const row = await one(
      `SELECT tutor_id FROM enrollments
        WHERE student_id = $1 AND tutor_id = $2
          AND status IN ('accepted', 'completed')
        LIMIT 1`,
      [socket.user.id, otherId]
    );

    return row ? { tutorId: row.tutor_id, studentId: socket.user.id } : null;
  }

  if (socket.user.role === 'tutor' && socket.tutorId) {
    const row = await one(
      `SELECT student_id FROM enrollments
        WHERE tutor_id = $1 AND student_id = $2
          AND status IN ('accepted', 'completed')
        LIMIT 1`,
      [socket.tutorId, otherId]
    );

    return row ? { tutorId: socket.tutorId, studentId: row.student_id } : null;
  }

  return null;
}

// Closes every live connection AND the HTTP server underneath. Used
// for a clean shutdown: a plain httpServer.close() waits forever for
// websocket clients that never hang up.
export function closeSockets() {
  return new Promise((resolve) => {
    if (!io) return resolve();
    io.close(() => resolve());
  });
}

// Marks everything the OTHER side sent as seen, and tells the room.
export async function markRead(pair, readerRole) {
  const from = readerRole === 'student' ? 'tutor' : 'student';
  const rows = await query(
    `UPDATE messages SET read_at = now(), delivered_at = COALESCE(delivered_at, now())
      WHERE tutor_id = $1 AND student_id = $2 AND sender = $3 AND read_at IS NULL
      RETURNING id`, [pair.tutorId, pair.studentId, from]);
  if (rows.length && io) {
    io.to(roomFor(pair.tutorId, pair.studentId)).emit('chat:seen', { ids: rows.map((r) => r.id), at: new Date() });
  }
  return rows.length;
}

// ------------------------------------------------------------
// Sending things out
// ------------------------------------------------------------
// Called from the routes. Each one is a no-op when sockets are not
// running, so nothing has to check first — a request that succeeds
// must not fail because the live layer is down.
// ------------------------------------------------------------
export function emitMessage(tutorId, studentId, message) {
  if (!io) return;
  io.to(roomFor(tutorId, studentId)).emit('chat:message', message);
}

// A badge should update even when the person is not looking at
// that conversation, so this goes to their own room instead.
export function emitToUser(userId, event, payload) {
  if (!io) return;
  io.to(userRoom(userId)).emit(event, payload);
}

export function socketsReady() {
  return Boolean(io);
}
