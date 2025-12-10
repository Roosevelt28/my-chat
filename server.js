// server.js — Express + Socket.IO realtime chat (public + private), session-integrated
const express = require('express');
const http = require('http');
const path = require('path');
const session = require('express-session');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Socket.IO with credentials for cookies
const io = new Server(server, { cors: { origin: true, credentials: true } });

const SESSION_SECRET = process.env.SESSION_SECRET || 'change_this_secret';

// Uncomment if behind TLS-terminating proxy (e.g., Render)
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

// Static files (client)
app.use(express.static(path.join(__dirname, 'public')));

// Simple demo auth: login with nickname only
app.post('/api/login', (req, res) => {
  const nick = (req.body.nickname || '').trim();
  if (!nick) return res.status(400).json({ error: 'Nickname required' });
  req.session.userId = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  req.session.username = nick;
  res.json({ ok: true, userId: req.session.userId, username: nick });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  res.json({ user: { id: req.session.userId, username: req.session.username } });
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
      } catch {}
    }
    broadcastUsers();
  });

  // Public message (broadcast to all)
  socket.on('chatMessage', ({ text }) => {
    const msg = {
      id: 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6),
      text: (text || '').trim(),
      username: socket.username,
      userId: socket.userId || null,
      ts: Date.now()
    };
    if (!msg.text) return;
    io.emit('message', msg);
  });

  // Private message by recipient username
  socket.on('privateMessage', ({ toUsername, text }) => {
    const body = (text || '').trim();
    if (!toUsername || !body) return;
    // find recipient userId by username
    let toUserId = null;
    for (const [uid, set] of socketsByUser.entries()) {
      for (const sid of set) {
        const s = io.sockets.sockets.get(sid);
        if (s && s.username === toUsername) { toUserId = uid; break; }
      }
      if (toUserId) break;
    }
    const msg = {
      id: 'pm_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6),
      text: body,
      fromUsername: socket.username,
      fromUserId: socket.userId || null,
      toUsername,
      toUserId,
      ts: Date.now()
    };
    if (!toUserId || !socketsByUser.has(toUserId)) {
      socket.emit('error', { error: 'Recipient not online' });
      return;
    }
    for (const sid of socketsByUser.get(toUserId)) {
      io.to(sid).emit('privateMessage', msg);
    }
    socket.emit('privateMessage', msg); // echo to sender
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
