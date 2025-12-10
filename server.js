// server.js — Express + Socket.IO realtime chat with SQLite persistence (public + private), session-integrated
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const cors = require('cors');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');

const APP_DIR = __dirname;
const DB_PATH = path.join(APP_DIR, 'data.db');

// ensure DB file exists
if (!fs.existsSync(DB_PATH)) {
  fs.writeFileSync(DB_PATH, '');
}

const db = new Database(DB_PATH);

// Create tables if not exist
db.prepare(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT,
  created_at INTEGER
)`).run();

db.prepare(`
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user TEXT,
  to_user TEXT,
  text TEXT,
  media_type TEXT,
  media_url TEXT,
  ts INTEGER
)`).run();

const app = express();
const server = http.createServer(app);

// Socket.IO with credentials for cookies
const io = new Server(server, { cors: { origin: true, credentials: true } });

const SESSION_SECRET = process.env.SESSION_SECRET || 'change_this_secret';

// If behind TLS-terminating proxy (Render), uncomment:
// app.set('trust proxy', 1);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Shared session middleware
const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,       // set true on HTTPS
    sameSite: 'lax'
  }
});
app.use(sessionMiddleware);

// Attach session to Socket.IO (Render-safe: pass {} as res)
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

// Serve static client
app.use(express.static(path.join(__dirname, 'public')));

// Simple demo auth: login with nickname only (stores session and lightweight user record)
app.post('/api/login', (req, res) => {
  const nick = (req.body.nickname || '').trim();
  if (!nick) return res.status(400).json({ error: 'Nickname required' });
  const userId = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  req.session.userId = userId;
  req.session.username = nick;
  // upsert into users table (for reference)
  db.prepare('INSERT OR REPLACE INTO users (id, username, created_at) VALUES (?, ?, ?)').run(userId, nick, Date.now());
  res.json({ ok: true, userId, username: nick });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  res.json({ user: { id: req.session.userId, username: req.session.username } });
});

// REST endpoints for message history
app.get('/api/messages/public', (req, res) => {
  const rows = db.prepare(`
    SELECT id, from_user, to_user, text, media_type, media_url, ts
    FROM messages
    WHERE to_user IS NULL
    ORDER BY ts DESC
    LIMIT 200
  `).all();
  res.json({ messages: rows.reverse() });
});

app.get('/api/messages/private/:username', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not auth' });
  const other = db.prepare('SELECT id, username FROM users WHERE username = ?').get(req.params.username);
  if (!other) return res.status(404).json({ error: 'User not found' });

  // fetch messages between session user and other
  const rows = db.prepare(`
    SELECT id, from_user, to_user, text, media_type, media_url, ts
    FROM messages
    WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)
    ORDER BY ts ASC
  `).all(req.session.userId, other.id, other.id, req.session.userId);
  res.json({ messages: rows });
});

// Presence tracking
const socketsByUser = new Map(); // userId -> Set(socketId)
const onlineSockets = new Set();

function broadcastUsers() {
  const list = [];
  for (const [uid, set] of socketsByUser.entries()) {
    if (set.size > 0) {
      const anySocketId = [...set][0];
      const s = io.sockets.sockets.get(anySocketId);
      if (s && s.username) list.push({ id: uid, username: s.username });
    }
  }
  io.emit('users', list);
}

io.on('connection', (socket) => {
  onlineSockets.add(socket.id);
  console.log('[WS] connected', socket.id);

  // Attach session identity if present
  try {
    const sess = socket.request.session;
    if (sess && sess.userId) {
      socket.userId = sess.userId;
      socket.username = sess.username;
      if (!socketsByUser.has(socket.userId)) socketsByUser.set(socket.userId, new Set());
      socketsByUser.get(socket.userId).add(socket.id);
    } else {
      socket.username = `Guest${Math.floor(Math.random() * 9000)}`;
    }
  } catch (e) {
    console.warn('session attach error', e);
  }

  // Send recent public messages to this socket (init)
  try {
    const rows = db.prepare(`
      SELECT id, from_user, to_user, text, media_type, media_url, ts
      FROM messages
      WHERE to_user IS NULL
      ORDER BY ts DESC
      LIMIT 200
    `).all();
    socket.emit('initMessages', rows.reverse());
  } catch (e) {
    console.error('initMessages error', e);
  }

  io.emit('onlineCount', { count: onlineSockets.size });
  broadcastUsers();

  // Fallback identify (optional)
  socket.on('identify', ({ userId, username }) => {
    socket.userId = userId || socket.userId;
    socket.username = username || socket.username;
    if (socket.userId) {
      if (!socketsByUser.has(socket.userId)) socketsByUser.set(socket.userId, new Set());
      socketsByUser.get(socket.userId).add(socket.id);
      try {
        if (socket.request && socket.request.session) {
          socket.request.session.userId = socket.userId;
          socket.request.session.username = socket.username;
          socket.request.session.save && socket.request.session.save();
        }
      } catch (e) { /* ignore */ }
    }
    broadcastUsers();
  });

  // Public message (persist then broadcast)
  socket.on('chatMessage', ({ text }) => {
    const cleanText = (text || '').trim();
    if (!cleanText) return;
    const fromUserId = socket.userId || null;
    const ts = Date.now();
    const info = db.prepare('INSERT INTO messages (from_user, to_user, text, media_type, media_url, ts) VALUES (?, ?, ?, ?, ?, ?)').run(
      fromUserId, null, cleanText, null, null, ts
    );
    const dbId = info.lastInsertRowid;
    const msg = {
      id: dbId,
      text: cleanText,
      username: socket.username,
      userId: fromUserId,
      ts
    };
    io.emit('message', msg);
  });

  // Private message (persist then send to recipient sockets)
  socket.on('privateMessage', ({ toUsername, text }) => {
    const body = (text || '').trim();
    if (!toUsername || !body) return;

    // find recipient user record
    const recipient = db.prepare('SELECT id, username FROM users WHERE username = ?').get(toUsername);
    if (!recipient) {
      // recipient might be a session-only user not in users table; try to find by socketsByUser
      let foundId = null;
      for (const [uid, set] of socketsByUser.entries()) {
        for (const sid of set) {
          const s = io.sockets.sockets.get(sid);
          if (s && s.username === toUsername) { foundId = uid; break; }
        }
        if (foundId) break;
      }
      if (!foundId) {
        socket.emit('error', { error: 'Recipient not found' });
        return;
      }
      recipient = { id: foundId, username: toUsername };
    }

    const ts = Date.now();
    const info = db.prepare('INSERT INTO messages (from_user, to_user, text, media_type, media_url, ts) VALUES (?, ?, ?, ?, ?, ?)').run(
      socket.userId || null, recipient.id, body, null, null, ts
    );
    const dbId = info.lastInsertRowid;

    const msg = {
      id: dbId,
      text: body,
      fromUsername: socket.username,
      fromUserId: socket.userId || null,
      toUsername: recipient.username,
      toUserId: recipient.id,
      ts
    };

    // deliver to recipient sockets if online
    const set = socketsByUser.get(recipient.id);
    if (set && set.size > 0) {
      for (const sid of set) {
        io.to(sid).emit('privateMessage', msg);
      }
      // echo to sender
      socket.emit('privateMessage', msg);
    } else {
      // recipient offline — still echo to sender and message is persisted for later retrieval
      socket.emit('privateMessage', msg);
    }
  });

  socket.on('disconnect', () => {
    onlineSockets.delete(socket.id);
    if (socket.userId && socketsByUser.has(socket.userId)) {
      const set = socketsByUser.get(socket.userId);
      set.delete(socket.id);
      if (set.size === 0) socketsByUser.delete(socket.userId);
    }
    io.emit('onlineCount', { count: onlineSockets.size });
    broadcastUsers();
    console.log('[WS] disconnect', socket.id);
  });
});

// Start
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
