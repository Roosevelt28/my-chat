// server.js
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const multer = require('multer');
const session = require('express-session');
const cors = require('cors');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const APP_DIR = __dirname;
const UPLOADS = path.join(APP_DIR, 'uploads');
if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS);

const db = new Database(path.join(APP_DIR, 'data.db'));

// DB init
db.prepare(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE,
  password TEXT,
  avatar TEXT
)`).run();

db.prepare(`
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user INTEGER,
  to_user INTEGER,
  text TEXT,
  media_url TEXT,
  media_type TEXT,
  ts INTEGER
)`).run();

// Multer for uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2,8)}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

const app = express();
const server = http.createServer(app);

// Socket.IO with CORS allowing credentials
const io = new Server(server, { cors: { origin: true, credentials: true } });

const SESSION_SECRET = process.env.SESSION_SECRET || 'change_this_secret';

// trust proxy if behind TLS terminator (Render)
app.set('trust proxy', 1);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// session middleware shared with socket.io
const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, sameSite: 'lax' } // set secure: true in production with HTTPS
});
app.use(sessionMiddleware);

// make session available to socket.io; pass empty res object for Render compatibility
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

app.use(express.static(path.join(APP_DIR, 'public')));
app.use('/uploads', express.static(UPLOADS));

// Helpers
function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}
function getUserByName(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

// Auth endpoints (simple)
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const info = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(username, hash);
    req.session.userId = info.lastInsertRowid;
    req.session.username = username;
    res.json({ ok: true, userId: info.lastInsertRowid, username });
  } catch (e) {
    res.status(400).json({ error: 'Username taken or invalid' });
  }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const row = db.prepare('SELECT id, password FROM users WHERE username = ?').get(username);
  if (!row) return res.status(401).json({ error: 'Invalid credentials' });
  if (!bcrypt.compareSync(password, row.password)) return res.status(401).json({ error: 'Invalid credentials' });
  req.session.userId = row.id;
  req.session.username = username;
  res.json({ ok: true, userId: row.id, username });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const u = getUserById(req.session.userId);
  if (!u) return res.json({ user: null });
  res.json({ user: { id: u.id, username: u.username, avatar: u.avatar } });
});

// Avatar upload
app.post('/api/upload/avatar', upload.single('avatar'), (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const url = `/uploads/${req.file.filename}`;
  db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(url, req.session.userId);
  res.json({ ok: true, avatar: url });
});

// Message photo upload (optional separate endpoint)
app.post('/api/upload/photo', upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const url = `/uploads/${req.file.filename}`;
  res.json({ ok: true, url });
});

// REST endpoint to fetch recent public messages
app.get('/api/messages/public', (req, res) => {
  const rows = db.prepare('SELECT id, from_user, to_user, text, media_url, media_type, ts FROM messages WHERE to_user IS NULL ORDER BY ts DESC LIMIT 200').all();
  res.json({ messages: rows.reverse() });
});

// Socket.IO realtime
const socketsByUser = new Map(); // userId -> Set(socketId)
const onlineSockets = new Set();

function broadcastOnline() {
  const onlineUsers = [];
  for (const [uid, set] of socketsByUser.entries()) {
    if (set.size > 0) {
      const u = getUserById(uid);
      if (u) onlineUsers.push({ id: u.id, username: u.username, avatar: u.avatar });
    }
  }
  io.emit('online', { count: onlineSockets.size, users: onlineUsers });
}

io.on('connection', socket => {
  console.log('[WS] connected', socket.id, 'sessionUserId=', socket.request && socket.request.session && socket.request.session.userId);

  // attach session user if present
  try {
    const sess = socket.request.session;
    if (sess && sess.userId) {
      socket.userId = sess.userId;
      socket.username = sess.username || null;
      if (!socketsByUser.has(socket.userId)) socketsByUser.set(socket.userId, new Set());
      socketsByUser.get(socket.userId).add(socket.id);
    } else {
      socket.username = `Guest${Math.floor(Math.random()*9000)}`;
    }
  } catch (e) {
    console.warn('session attach error', e);
  }

  onlineSockets.add(socket.id);
  broadcastOnline();

  // send recent public messages on connect
  try {
    const rows = db.prepare('SELECT id, from_user, text, media_url, media_type, ts FROM messages WHERE to_user IS NULL ORDER BY ts DESC LIMIT 200').all();
    socket.emit('initMessages', rows.reverse());
  } catch (e) {
    console.error('initMessages error', e);
  }

  socket.on('chatMessage', ({ text, media }) => {
    console.log('[WS] chatMessage', socket.id, 'userId=', socket.userId);
    const fromUserId = socket.userId || null;
    const ts = Date.now();
    const info = db.prepare('INSERT INTO messages (from_user, to_user, text, media_url, media_type, ts) VALUES (?, ?, ?, ?, ?, ?)').run(
      fromUserId, null, text || '', media ? media.url : null, media ? media.type : null, ts
    );
    const dbId = info.lastInsertRowid;
    const msg = { id: dbId, from_user: fromUserId, text: text || '', media_url: media ? media.url : null, media_type: media ? media.type : null, ts };
    io.emit('message', msg);
  });

  socket.on('privateMessage', ({ toUserId, text, media }) => {
    const toSet = socketsByUser.get(toUserId);
    const fromUserId = socket.userId || null;
    const ts = Date.now();
    const info = db.prepare('INSERT INTO messages (from_user, to_user, text, media_url, media_type, ts) VALUES (?, ?, ?, ?, ?, ?)').run(
      fromUserId, toUserId, text || '', media ? media.url : null, media ? media.type : null, ts
    );
    const dbId = info.lastInsertRowid;
    const msg = { id: dbId, from_user: fromUserId, to_user: toUserId, text: text || '', media_url: media ? media.url : null, media_type: media ? media.type : null, ts };
    if (toSet) for (const sid of toSet) io.to(sid).emit('privateMessage', msg);
    socket.emit('privateMessage', msg);
  });

  socket.on('identify', ({ userId, username }) => {
    // fallback for clients without session cookie
    socket.userId = userId || socket.userId || null;
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
      } catch (e) {}
    }
    broadcastOnline();
  });

  socket.on('disconnect', () => {
    console.log('[WS] disconnect', socket.id);
    onlineSockets.delete(socket.id);
    if (socket.userId) {
      const set = socketsByUser.get(socket.userId);
      if (set) {
        set.delete(socket.id);
        if (set.size === 0) socketsByUser.delete(socket.userId);
      }
    }
    broadcastOnline();
  });
});

// Start
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
