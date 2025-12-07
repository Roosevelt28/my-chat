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
const { v4: uuidv4 } = require('uuid');

const APP_DIR = __dirname;
const UPLOADS = path.join(APP_DIR, 'uploads');
if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS);

const db = new Database(path.join(APP_DIR, 'data.db'));

// DB init with blocked flag and profile_locked flag
db.prepare(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE,
  password TEXT,
  first_name TEXT,
  last_name TEXT,
  nickname TEXT,
  email TEXT,
  age INTEGER,
  avatar TEXT,
  messages_visibility TEXT DEFAULT 'public',
  allow_private INTEGER DEFAULT 1,
  blocked INTEGER DEFAULT 0,
  profile_locked INTEGER DEFAULT 0
)`).run();

db.prepare(`
CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  url TEXT,
  created_at INTEGER
)`).run();

db.prepare(`
CREATE TABLE IF NOT EXISTS friends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  friend_user_id INTEGER
)`).run();

db.prepare(`
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user INTEGER,
  to_user INTEGER,
  text TEXT,
  media_type TEXT,
  media_url TEXT,
  ts INTEGER
)`).run();

// multer setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    cb(null, `${Date.now()}-${uuidv4()}${ext}`);
  }
});
function fileFilter (req, file, cb) {
  const allowedExt = /\.(jpe?g|png|gif|webm|wav|mp3|ogg|mp4)$/i;
  if (allowedExt.test(file.originalname)) cb(null, true);
  else cb(new Error('Unsupported file type'), false);
}
const upload = multer({ storage, fileFilter, limits: { fileSize: 20 * 1024 * 1024 } });

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// **Admin password**: change via environment variable or replace default here
const ADMIN_PASS = process.env.ADMIN_PASS || 'adminpass';

const SESSION_SECRET = process.env.SESSION_SECRET || 'change_this_secret';
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
}));

app.use(express.static(path.join(APP_DIR, 'public')));
app.use('/uploads', express.static(UPLOADS));

// Helpers
function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}
function getUserByName(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}
function getUserPhotosCount(userId) {
  return db.prepare('SELECT COUNT(*) as c FROM photos WHERE user_id = ?').get(userId).c;
}
function areFriends(aId, bId) {
  if (!aId || !bId) return false;
  const r = db.prepare('SELECT id FROM friends WHERE user_id = ? AND friend_user_id = ?').get(aId, bId);
  const r2 = db.prepare('SELECT id FROM friends WHERE user_id = ? AND friend_user_id = ?').get(bId, aId);
  return !!(r || r2);
}

// Admin middleware
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(403).json({ error: 'Forbidden' });
}

// Auth endpoints
app.post('/api/register', (req, res) => {
  const { username, password, first_name, last_name, nickname, email, age } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const info = db.prepare(`INSERT INTO users (username, password, first_name, last_name, nickname, email, age) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(username, hash, first_name || null, last_name || null, nickname || null, email || null, age ? Number(age) : null);
    req.session.userId = info.lastInsertRowid;
    return res.json({ ok: true, userId: info.lastInsertRowid, username });
  } catch (e) {
    return res.status(400).json({ error: 'Username taken or invalid data' });
  }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const row = db.prepare('SELECT id, password, blocked FROM users WHERE username = ?').get(username);
  if (!row) return res.status(401).json({ error: 'Invalid credentials' });
  if (row.blocked) return res.status(403).json({ error: 'User is blocked' });
  if (!bcrypt.compareSync(password, row.password)) return res.status(401).json({ error: 'Invalid credentials' });
  req.session.userId = row.id;
  res.json({ ok: true, userId: row.id, username });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const u = getUserById(req.session.userId);
  if (!u) return res.json({ user: null });
  res.json({ user: {
    id: u.id, username: u.username, first_name: u.first_name, last_name: u.last_name,
    nickname: u.nickname, email: u.email, age: u.age, avatar: u.avatar,
    messages_visibility: u.messages_visibility, allow_private: !!u.allow_private,
    blocked: !!u.blocked, profile_locked: !!u.profile_locked
  }});
});

// Admin login/logout/check
app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASS) {
    req.session.isAdmin = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Invalid' });
});
app.post('/admin/logout', (req, res) => {
  req.session.isAdmin = false;
  res.json({ ok: true });
});
app.get('/admin/check', (req, res) => {
  res.json({ isAdmin: !!req.session.isAdmin });
});

// Admin functions: list users, block/unblock, force view profile
app.get('/admin/users', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT id, username, avatar, email, blocked, profile_locked FROM users').all();
  res.json({ users: rows });
});

app.post('/admin/block', requireAdmin, (req, res) => {
  const { username } = req.body;
  const u = getUserByName(username);
  if (!u) return res.status(404).json({ error: 'User not found' });
  db.prepare('UPDATE users SET blocked = 1 WHERE id = ?').run(u.id);
  res.json({ ok: true, message: `${username} blocked` });
});

app.post('/admin/unblock', requireAdmin, (req, res) => {
  const { username } = req.body;
  const u = getUserByName(username);
  if (!u) return res.status(404).json({ error: 'User not found' });
  db.prepare('UPDATE users SET blocked = 0 WHERE id = ?').run(u.id);
  res.json({ ok: true, message: `${username} unblocked` });
});

app.post('/admin/lock-profile', requireAdmin, (req, res) => {
  const { username } = req.body;
  const u = getUserByName(username);
  if (!u) return res.status(404).json({ error: 'User not found' });
  db.prepare('UPDATE users SET profile_locked = 1 WHERE id = ?').run(u.id);
  res.json({ ok: true, message: `${username} profile locked` });
});

app.post('/admin/unlock-profile', requireAdmin, (req, res) => {
  const { username } = req.body;
  const u = getUserByName(username);
  if (!u) return res.status(404).json({ error: 'User not found' });
  db.prepare('UPDATE users SET profile_locked = 0 WHERE id = ?').run(u.id);
  res.json({ ok: true, message: `${username} profile unlocked` });
});

// Admin forced profile view (ignores profile_locked and visibility)
app.get('/admin/view-profile/:username', requireAdmin, (req, res) => {
  const user = getUserByName(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  // return full profile regardless of profile_locked
  res.json({
    username: user.username,
    first_name: user.first_name,
    last_name: user.last_name,
    nickname: user.nickname,
    email: user.email,
    age: user.age,
    avatar: user.avatar,
    blocked: !!user.blocked,
    profile_locked: !!user.profile_locked,
    messages_visibility: user.messages_visibility,
    allow_private: !!user.allow_private
  });
});

// Upload endpoints
app.post('/api/upload/avatar', upload.single('avatar'), (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not auth' });
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const url = `/uploads/${req.file.filename}`;
  db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(url, req.session.userId);
  res.json({ ok: true, avatar: url });
});
app.post('/api/upload/photo', upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const url = `/uploads/${req.file.filename}`;
  const personal = req.query.personal === '1';
  if (personal) {
    if (!req.session.userId) {
      fs.unlinkSync(req.file.path);
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const count = getUserPhotosCount(req.session.userId);
    if (count >= 10) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'პირადი ფოტოების ლიმიტი 10 არის' });
    }
    db.prepare('INSERT INTO photos (user_id, url, created_at) VALUES (?, ?, ?)').run(req.session.userId, url, Date.now());
  }
  res.json({ ok: true, url });
});
app.post('/api/upload/audio', upload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const url = `/uploads/${req.file.filename}`;
  res.json({ ok: true, url });
});

// Get user photos
app.get('/api/users/:username/photos', (req, res) => {
  const username = req.params.username;
  const user = getUserByName(username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const photos = db.prepare('SELECT id, url, created_at FROM photos WHERE user_id = ? ORDER BY created_at DESC').all(user.id);
  res.json({ photos });
});

// Get user profile respecting profile_locked and visibility
app.get('/api/users/:username', (req, res) => {
  const user = getUserByName(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // If profile is locked and requester is not admin, hide sensitive fields
  const requesterIsAdmin = req.session && req.session.isAdmin;
  if (user.profile_locked && !requesterIsAdmin) {
    // limited public view
    return res.json({
      username: user.username,
      first_name: null,
      last_name: null,
      nickname: user.nickname || null,
      avatar: user.avatar || null,
      age: null,
      messages_visibility: user.messages_visibility,
      allow_private: !!user.allow_private,
      profile_locked: true
    });
  }

  // normal public view (respect messages_visibility for messaging logic elsewhere)
  res.json({
    username: user.username,
    first_name: user.first_name || null,
    last_name: user.last_name || null,
    nickname: user.nickname || null,
    avatar: user.avatar || null,
    age: user.age || null,
    messages_visibility: user.messages_visibility,
    allow_private: !!user.allow_private,
    profile_locked: !!user.profile_locked
  });
});

// Friends/settings endpoints
app.post('/api/me/settings', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not auth' });
  const { messages_visibility, allow_private } = req.body;
  if (messages_visibility && !['public','friends','private'].includes(messages_visibility)) return res.status(400).json({ error: 'Invalid' });
  db.prepare('UPDATE users SET messages_visibility = ?, allow_private = ? WHERE id = ?')
    .run(messages_visibility || 'public', allow_private ? 1 : 0, req.session.userId);
  res.json({ ok: true });
});
app.post('/api/friends/add', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not auth' });
  const { username } = req.body;
  const friend = getUserByName(username);
  if (!friend) return res.status(404).json({ error: 'User not found' });
  const exists = db.prepare('SELECT id FROM friends WHERE user_id = ? AND friend_user_id = ?').get(req.session.userId, friend.id);
  if (exists) return res.json({ ok: true });
  db.prepare('INSERT INTO friends (user_id, friend_user_id) VALUES (?, ?)').run(req.session.userId, friend.id);
  res.json({ ok: true });
});
app.post('/api/friends/remove', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not auth' });
  const { username } = req.body;
  const friend = getUserByName(username);
  if (!friend) return res.status(404).json({ error: 'User not found' });
  db.prepare('DELETE FROM friends WHERE user_id = ? AND friend_user_id = ?').run(req.session.userId, friend.id);
  res.json({ ok: true });
});

// Messages API
app.get('/api/messages/public', (req, res) => {
  const rows = db.prepare('SELECT id, from_user, to_user, text, media_type, media_url, ts FROM messages WHERE to_user IS NULL ORDER BY ts DESC LIMIT 200').all();
  res.json({ messages: rows.reverse() });
});
app.get('/api/messages/private/:username', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not auth' });
  const other = getUserByName(req.params.username);
  if (!other) return res.status(404).json({ error: 'User not found' });
  // block checks
  const me = getUserById(req.session.userId);
  if (me.blocked) return res.status(403).json({ error: 'You are blocked' });
  if (other.blocked) return res.status(403).json({ error: 'User is blocked' });

  // visibility checks
  if (other.messages_visibility === 'friends' && !areFriends(req.session.userId, other.id)) {
    return res.status(403).json({ error: 'Messages visible to friends only' });
  }
  if (other.messages_visibility === 'private') {
    return res.status(403).json({ error: 'User does not accept messages' });
  }

  const rows = db.prepare('SELECT id, from_user, to_user, text, media_type, media_url, ts FROM messages WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?) ORDER BY ts ASC')
    .all(req.session.userId, other.id, other.id, req.session.userId);
  res.json({ messages: rows });
});

// Socket.io: presence, messaging, and WebRTC signaling
const socketsByUser = new Map(); // userId -> Set(socketId)
const onlineSockets = new Set(); // all connected socket ids

function broadcastOnline() {
  const onlineCount = onlineSockets.size;
  const onlineUsers = [];
  for (const [uid, set] of socketsByUser.entries()) {
    if (set.size > 0) {
      const u = getUserById(uid);
      if (u) onlineUsers.push({ id: u.id, username: u.username, avatar: u.avatar });
    }
  }
  io.emit('onlineCount', { count: onlineCount, users: onlineUsers });
}

io.on('connection', socket => {
  onlineSockets.add(socket.id);
  console.log('socket connected', socket.id);
  broadcastOnline();

  socket.on('identify', ({ userId, username }) => {
    socket.userId = userId || null;
    socket.username = username || `User${Math.floor(Math.random()*9000)}`;
    if (socket.userId) {
      if (!socketsByUser.has(socket.userId)) socketsByUser.set(socket.userId, new Set());
      socketsByUser.get(socket.userId).add(socket.id);
    }
    const users = db.prepare('SELECT id, username, avatar FROM users').all();
    io.emit('users', users.map(u => ({ id: u.id, username: u.username, avatar: u.avatar })));
    broadcastOnline();
  });

  socket.on('chatMessage', ({ text, media }) => {
    // if sender is blocked, ignore
    if (socket.userId) {
      const sender = getUserById(socket.userId);
      if (sender && sender.blocked) {
        socket.emit('error', { error: 'You are blocked' });
        return;
      }
    }
    const fromUser = socket.userId ? getUserById(socket.userId) : { username: socket.username };
    const msg = {
      id: uuidv4(),
      from_user: socket.userId || null,
      username: fromUser.username,
      to_user: null,
      text: text || '',
      media_type: media ? media.type : null,
      media_url: media ? media.url : null,
      ts: Date.now()
    };
    db.prepare('INSERT INTO messages (from_user, to_user, text, media_type, media_url, ts) VALUES (?, ?, ?, ?, ?, ?)')
      .run(msg.from_user, null, msg.text, msg.media_type, msg.media_url, msg.ts);
    io.emit('message', msg);
  });

  socket.on('privateMessage', ({ toUsername, text, media }) => {
    const toUser = getUserByName(toUsername);
    const fromUser = socket.userId ? getUserById(socket.userId) : null;
    const fromName = fromUser ? fromUser.username : socket.username;
    if (!toUser) {
      socket.emit('error', { error: 'მომხმარებელი არ მოიძებნა' });
      return;
    }
    // block checks
    if (fromUser && fromUser.blocked) {
      socket.emit('error', { error: 'You are blocked' });
      return;
    }
    if (toUser.blocked) {
      socket.emit('error', { error: 'Recipient is blocked' });
      return;
    }
    // visibility checks
    if (toUser.messages_visibility === 'friends' && !areFriends(socket.userId, toUser.id)) {
      socket.emit('error', { error: 'Recipient accepts messages from friends only' });
      return;
    }
    if (toUser.messages_visibility === 'private') {
      socket.emit('error', { error: 'Recipient does not accept messages' });
      return;
    }

    const msg = {
      id: uuidv4(),
      from_user: socket.userId || null,
      username: fromName,
      to_user: toUser.id,
      text: text || '',
      media_type: media ? media.type : null,
      media_url: media ? media.url : null,
      ts: Date.now()
    };
    db.prepare('INSERT INTO messages (from_user, to_user, text, media_type, media_url, ts) VALUES (?, ?, ?, ?, ?, ?)')
      .run(msg.from_user, msg.to_user, msg.text, msg.media_type, msg.media_url, msg.ts);

    const set = socketsByUser.get(toUser.id);
    if (set) {
      for (const sid of set) io.to(sid).emit('privateMessage', msg);
    }
    socket.emit('privateMessage', msg);
  });

  // WebRTC signaling (same as earlier examples)
  socket.on('call-offer', ({ toUsername, offer, callType }) => {
    const toUser = getUserByName(toUsername);
    if (!toUser) return socket.emit('error', { error: 'User not found' });
    const set = socketsByUser.get(toUser.id);
    if (set) {
      for (const sid of set) io.to(sid).emit('incoming-call', { from: socket.username || 'Anonymous', fromUserId: socket.userId, offer, callType });
    }
  });

  socket.on('call-answer', ({ toUsername, answer }) => {
    const toUser = getUserByName(toUsername);
    if (!toUser) return;
    const set = socketsByUser.get(toUser.id);
    if (set) {
      for (const sid of set) io.to(sid).emit('call-answered', { from: socket.username || 'Anonymous', answer });
    }
  });

  socket.on('call-candidate', ({ toUsername, candidate }) => {
    const toUser = getUserByName(toUsername);
    if (!toUser) return;
    const set = socketsByUser.get(toUser.id);
    if (set) {
      for (const sid of set) io.to(sid).emit('call-candidate', { from: socket.username || 'Anonymous', candidate });
    }
  });

  socket.on('call-end', ({ toUsername }) => {
    const toUser = getUserByName(toUsername);
    if (!toUser) return;
    const set = socketsByUser.get(toUser.id);
    if (set) {
      for (const sid of set) io.to(sid).emit('call-ended', { from: socket.username || 'Anonymous' });
    }
  });

  socket.on('typing', ({ toUsername, isTyping }) => {
    if (toUsername) {
      const toUser = getUserByName(toUsername);
      if (!toUser) return;
      const set = socketsByUser.get(toUser.id);
      if (set) {
        for (const sid of set) io.to(sid).emit('typing', { from: socket.username || 'Anonymous', private: true, isTyping });
      }
    } else {
      socket.broadcast.emit('typing', { from: socket.username || 'Anonymous', private: false, isTyping });
    }
  });

  socket.on('disconnect', () => {
    onlineSockets.delete(socket.id);
    if (socket.userId) {
      const set = socketsByUser.get(socket.userId);
      if (set) {
        set.delete(socket.id);
        if (set.size === 0) socketsByUser.delete(socket.userId);
      }
    }
    console.log('socket disconnected', socket.id);
    broadcastOnline();
  });
});

const path = require('path');
const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);

// static ფაილების სერვირება
app.use(express.static(path.join(__dirname, 'public')));

// root როუტი
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// start
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});




