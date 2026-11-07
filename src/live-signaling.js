'use strict';
// Media never passes through Socket.IO; only authorized, room-scoped signaling does.
module.exports = function attachLiveSignaling(io, q, jwt, secret) {
  const members = new Map();
  const broadcasters = new Map();
  function count(lid) {
    const n = [...(members.get(lid) || [])].filter(id => {
      const s = io.sockets.sockets.get(id);
      return s && !s.data.is_broadcaster;
    }).length;
    q.run('UPDATE lives SET peak_viewers=MAX(peak_viewers,?) WHERE id=?', n, lid);
    io.to(`live:${lid}`).emit('viewer_count', { live_id: lid, count: n });
  }
  function leave(socket) {
    const lid = socket.data.live_id;
    if (!lid) return;
    socket.leave(`live:${lid}`);
    const set = members.get(lid);
    if (set) { set.delete(socket.id); if (!set.size) members.delete(lid); }
    socket.to(`live:${lid}`).emit('viewer_left', { socketId: socket.id });
    if (broadcasters.get(lid) === socket.id) {
      broadcasters.delete(lid);
      // Only an explicit model/admin end ends a session. Refresh/offline never
      // creates a new live ID or destroys already purchased tickets.
      const live = q.get("SELECT id FROM lives WHERE id=? AND status='live'", lid);
      if (live) io.to(`live:${lid}`).emit('broadcaster_reconnecting', { live_id: lid });
    }
    socket.data.live_id = null;
    socket.data.is_broadcaster = false;
    count(lid);
  }
  io.use((socket, next) => {
    try {
      const p = jwt.verify(socket.handshake.auth && socket.handshake.auth.token, secret);
      const u = q.get('SELECT id,name,role,status,verified,restricted FROM users WHERE id=?', p.id);
      if (!u || u.status !== 'active') return next(new Error('unauthorized'));
      socket.user = u; next();
    } catch { next(new Error('unauthorized')); }
  });
  io.on('connection', socket => {
    socket.on('join_live', (payload = {}) => {
      try {
        if (!payload || typeof payload !== 'object') return;
        const lid = Number(payload.live_id);
        if (!Number.isSafeInteger(lid) || lid <= 0) return;
        const live = q.get("SELECT * FROM lives WHERE id=? AND status='live'", lid);
        if (!live) return socket.emit('error_msg', { error: 'Live not found or already ended' });
        const u = q.get('SELECT id,name,role,status,verified,restricted FROM users WHERE id=?', socket.user.id);
        if (!u || u.status !== 'active' || (!u.verified && u.role !== 'admin')) return socket.emit('error_msg', { error: 'Active identity verification required' });
        const isModel = live.model_id === u.id;
        if (!isModel && u.role !== 'admin') {
          if (u.restricted) return socket.emit('error_msg', { error: 'Your account is restricted' });
          let access = q.get('SELECT id FROM live_access WHERE live_id=? AND user_id=?', lid, u.id);
          if (!access && live.price_cents === 0 && q.get("SELECT id FROM subscriptions WHERE model_id=? AND client_id=? AND status='active'", live.model_id, u.id)) {
            q.run('INSERT OR IGNORE INTO live_access(live_id,user_id,paid_cents) VALUES(?,?,0)', lid, u.id);
            access = true;
          }
          if (!access) return socket.emit('error_msg', { error: 'Payment required to watch this live' });
        }
        if (socket.data.live_id && socket.data.live_id !== lid) leave(socket);
        socket.user = u;
        socket.join(`live:${lid}`);
        socket.data.live_id = lid;
        socket.data.is_broadcaster = isModel;
        if (!members.has(lid)) members.set(lid, new Set());
        members.get(lid).add(socket.id);
        if (isModel) {
          const previous = broadcasters.get(lid);
          broadcasters.set(lid, socket.id);
          if (previous && previous !== socket.id) {
            const old = io.sockets.sockets.get(previous);
            if (old) { old.emit('broadcast_replaced'); leave(old); }
          }
          const ids = [...members.get(lid)].filter(id => id !== socket.id);
          socket.emit('existing_viewers', { viewers: ids });
          socket.to(`live:${lid}`).emit('broadcaster_ready');
        } else {
          const broadcaster = broadcasters.get(lid);
          if (broadcaster) io.to(broadcaster).emit('viewer_joined', { socketId: socket.id });
          else socket.emit('broadcaster_reconnecting', { live_id: lid });
        }
        socket.emit('live_joined', { live_id: lid, broadcaster: isModel });
        count(lid);
        const history = q.all(`SELECT c.message,c.created_at,u.name,u.role FROM chat c JOIN users u ON u.id=c.user_id WHERE c.live_id=? ORDER BY c.id DESC LIMIT 30`, lid).reverse();
        socket.emit('chat_history', history);
      } catch (err) { console.error('[live join]', err); socket.emit('error_msg', { error: 'Unable to join live. Please reconnect.' }); }
    });
    for (const event of ['webrtc_offer', 'webrtc_answer', 'webrtc_ice']) {
      socket.on(event, (payload = {}) => {
        if (!payload || typeof payload !== 'object') return;
        const lid = socket.data.live_id;
        if (!lid || !q.get("SELECT id FROM lives WHERE id=? AND status='live'", lid)) return;
        const target = io.sockets.sockets.get(payload.to);
        if (!target || target.data.live_id !== lid || target.id === socket.id) return;
        if (event === 'webrtc_offer' && !socket.data.is_broadcaster) return;
        if (event === 'webrtc_answer' && (socket.data.is_broadcaster || !target.data.is_broadcaster)) return;
        if (event === 'webrtc_ice' && socket.data.is_broadcaster === target.data.is_broadcaster) return;
        if (socket.data.is_broadcaster && broadcasters.get(lid) !== socket.id) return;
        if (!socket.data.is_broadcaster && broadcasters.get(lid) !== target.id) return;
        const key = event === 'webrtc_ice' ? 'candidate' : 'sdp';
        const value = payload[key];
        if (!value || typeof value !== 'object' || JSON.stringify(value).length > 100000 || typeof payload.session !== 'string' || payload.session.length > 100) return;
        io.to(target.id).emit(event, { from: socket.id, to: target.id, session: payload.session, [key]: value });
      });
    }
    socket.on('request_offer', () => {
      const lid = socket.data.live_id;
      if (!lid || socket.data.is_broadcaster || !q.get("SELECT id FROM lives WHERE id=? AND status='live'", lid)) return;
      const now = Date.now();
      if (now - (socket.data.lastRequest || 0) < 1500) return;
      socket.data.lastRequest = now;
      const id = broadcasters.get(lid);
      if (id) io.to(id).emit('viewer_joined', { socketId: socket.id });
    });
    socket.on('chat', (payload = {}) => {
      if (!payload || typeof payload !== 'object') return;
      const lid = Number(payload.live_id);
      if (!lid || socket.data.live_id !== lid) return;
      const u = q.get('SELECT name,role,status,restricted,verified FROM users WHERE id=?', socket.user.id);
      if (!u || u.status !== 'active' || u.restricted || !u.verified) return;
      if (!q.get("SELECT id FROM lives WHERE id=? AND status='live'", lid)) return;
      const msg = String(payload.message || '').trim().slice(0, 300);
      if (!msg) return;
      q.run('INSERT INTO chat(live_id,user_id,message) VALUES(?,?,?)', lid, socket.user.id, msg);
      io.to(`live:${lid}`).emit('chat', { name: u.name, role: u.role, message: msg, at: new Date().toISOString() });
    });
    socket.on('leave_live', () => leave(socket));
    socket.on('disconnect', () => leave(socket));
  });
};
