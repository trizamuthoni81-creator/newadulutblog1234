'use strict';
const crypto = require('crypto');
const STUN = { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] };
function buildRTCConfig(userId, env = process.env, now = Date.now()) {
  let iceServers = [STUN];
  const ttl = Math.max(600, Math.min(86400, Number(env.TURN_TTL_SECONDS) || 21600));
  if (env.RTC_ICE_SERVERS) {
    const supplied = JSON.parse(env.RTC_ICE_SERVERS);
    if (!Array.isArray(supplied) || !supplied.length) throw new Error('RTC_ICE_SERVERS must be a nonempty JSON array');
    iceServers = supplied;
  } else if (env.TURN_URLS) {
    const urls = env.TURN_URLS.split(',').map(s => s.trim()).filter(Boolean);
    let username = env.TURN_USERNAME, credential = env.TURN_CREDENTIAL;
    if (env.TURN_SECRET) {
      username = `${Math.floor(now / 1000) + ttl}:${userId}`;
      credential = crypto.createHmac('sha1', env.TURN_SECRET).update(username).digest('base64');
    }
    if (!username || !credential) throw new Error('TURN requires TURN_SECRET or TURN_USERNAME and TURN_CREDENTIAL');
    iceServers.push({ urls, username, credential });
  }
  for (const s of iceServers) {
    const urls = typeof s.urls === 'string' ? [s.urls] : s.urls;
    if (!Array.isArray(urls) || !urls.length || urls.some(u => typeof u !== 'string' || !/^(stun|stuns|turn|turns):[^\s]+$/i.test(u))) throw new Error('Invalid ICE server URL');
    if (urls.some(u => /^turns?:/i.test(u)) && (!s.username || !s.credential)) throw new Error('TURN server credentials are required');
  }
  const turnConfigured = iceServers.some(s => [].concat(s.urls).some(u => /^turns?:/i.test(u)));
  const iceTransportPolicy = env.RTC_FORCE_RELAY === 'true' ? 'relay' : 'all';
  if (iceTransportPolicy === 'relay' && !turnConfigured) throw new Error('Relay-only mode requires TURN');
  return { iceServers, iceTransportPolicy, turnConfigured, expiresAt: now + ttl * 1000 };
}
module.exports = { buildRTCConfig };
