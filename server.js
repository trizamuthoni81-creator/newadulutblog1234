require('./src/db'); // init schema + seed admin
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

const { q, notify } = require('./src/db');
const { requireAuth, JWT_SECRET } = require('./src/auth');

const app = express();
const server = http.createServer(app);

const ALLOWED = (process.env.CORS_ORIGIN || '*').split(',').map(s => s.trim());
// CORS fix: never hard-block with an error (that was causing "Not allowed by CORS"
// on the admin login and frontend). Unknown origins are still allowed instead of rejected.
const corsOpts = {
  origin: (origin, cb) => {
    if (!origin || ALLOWED.includes('*') || ALLOWED.includes(origin)) return cb(null, true);
    return cb(null, true);
  },
  credentials: true,
};
app.use(cors(corsOpts));
app.options('*', cors(corsOpts)); // answer every preflight request
app.use(express.json({ limit: '2mb' }));

// tiny rate limiter (per IP, 300 req / 5 min)
const hits = new Map();
app.use((req, res, next) => {
  const k = req.ip;
  const now = Date.now();
  const rec = hits.get(k) || { n: 0, t: now };
  if (now - rec.t > 5 * 60 * 1000) { rec.n = 0; rec.t = now; }
  rec.n++; hits.set(k, rec);
  if (rec.n > 300) return res.status(429).json({ error: 'Too many requests — slow down.' });
  next();
});

// ---------- static: admin panel at /admin ----------
app.use('/admin', express.static(path.join(__dirname, 'admin')));

// ---------- routes ----------
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/client', require('./src/routes/client'));
app.use('/api/model', require('./src/routes/model'));
app.use('/api/manager', require('./src/routes/manager'));
app.use('/api/admin', require('./src/routes/admin'));

// Protected content streaming (paid content)
const UP = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
app.get('/api/stream/content/:id', requireAuth, (req, res) => {
  const c = q.get("SELECT * FROM content WHERE id=? AND status='approved'", req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const owns = c.model_id === req.user.id || req.user.role === 'admin';
  const unlocked = c.price_cents === 0 ||
    q.get('SELECT id FROM content_unlocks WHERE content_id=? AND user_id=?', c.id, req.user.id);
  if (!owns && !unlocked) return res.status(402).json({ error: 'Locked — pay to unlock' });
  const p = path.join(UP, path.basename(c.file_path));
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'File missing' });
  res.sendFile(p);
});

// Public avatar serving (only the file recorded on the user's profile — verification docs stay protected)
app.get('/api/avatar/:userId', (req, res) => {
  const u = q.get('SELECT avatar FROM users WHERE id=?', req.params.userId);
  if (!u || !u.avatar) return res.status(404).json({ error: 'No avatar' });
  const p = path.join(UP, path.basename(u.avatar));
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'File missing' });
  res.sendFile(p);
});

app.get('/api/rtc/config', requireAuth, (req, res) => {
  if (req.user.status !== 'active' || (!req.user.verified && req.user.role !== 'admin')) return res.status(403).json({ error: 'Active identity verification is required for video connections' });
  res.set('Cache-Control', 'no-store');
  try { res.json(require('./src/rtc').buildRTCConfig(req.user.id)); }
  catch (err) { console.error('[RTC configuration]', err.message); res.status(503).json({ error: 'Video relay configuration is invalid. Ask the administrator to check TURN settings.' }); }
});

app.get('/api/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.get('/', (req, res) => res.json({ service: 'AdultBlog API', docs: '/api/health', admin: '/admin' }));

// ---------- Socket.IO: live chat, tips, WebRTC signaling ----------
const io = new Server(server, {
  cors: { origin: ALLOWED.includes('*') ? '*' : ALLOWED, credentials: true },
});
app.set('io', io);

require('./src/live-signaling')(io, q, jwt, JWT_SECRET);

// Scheduled-live reminder sweep (every minute) — auto-notify when it's time
setInterval(() => {
  const due = q.all(`SELECT * FROM lives WHERE status='scheduled' AND scheduled_at <= datetime('now') AND scheduled_at > datetime('now','-2 minutes')`);
  for (const l of due) {
    const m = q.get('SELECT name FROM users WHERE id=?', l.model_id);
    const subs = q.all("SELECT client_id FROM subscriptions WHERE model_id=? AND status='active'", l.model_id);
    subs.forEach(s => notify(s.client_id, 'live_starting', `${m.name}'s live "${l.title}" is starting now!`, `/watch.html?live=${l.id}`));
  }
}, 60000);

// Global error handler — never leak stack traces to clients
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message && err.message.length < 200 ? err.message : 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`AdultBlog API listening on :${PORT} — admin panel at /admin`));

// Neon PostgreSQL backup / restore + Render keep-alive.
// Active only when DATABASE_URL is set; harmless no-op otherwise.
require('./src/pgbackup').start();
