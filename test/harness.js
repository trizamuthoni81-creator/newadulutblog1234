'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adultblog-test-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.UPLOAD_DIR = path.join(dir, 'uploads');
process.env.JWT_SECRET = 'isolated-test-secret-not-for-production';
process.env.ADMIN_PASSWORD = 'isolated-test-admin-password';
process.env.DATABASE_URL = '';
const { db, q } = require('../src/db');
const { sign } = require('../src/auth');
const bcrypt = require('bcryptjs');
const passHash = bcrypt.hashSync('TestPassword!234', 4);
function user(name, role = 'client', verified = 1) {
  const id = Number(q.run("INSERT INTO users(email,pass_hash,name,role,status,dob,verified,eligible,agency_approved) VALUES(?,?,?,?,'active','1990-01-01',?,1,1)", name.toLowerCase()+'@test.invalid', passHash, name, role, verified).lastInsertRowid);
  if (role === 'model') q.run('INSERT INTO model_profiles(user_id,display_name) VALUES(?,?)', id, name);
  const u = q.get('SELECT * FROM users WHERE id=?', id);
  const { pass_hash, ...safe } = u;
  return { ...safe, token: sign(u) };
}
const admin = q.get("SELECT * FROM users WHERE role='admin'");
admin.token = sign(admin);
function live(model, price = 15000) {
  const id = Number(q.run("INSERT INTO lives(model_id,title,price_cents,status,started_at) VALUES(?, 'Transport regression test',?,'live',datetime('now'))", model.id, price).lastInsertRowid);
  q.run('UPDATE model_profiles SET is_live=1 WHERE user_id=?', model.id);
  return id;
}
function document(user, dob='1990-01-01') {
  fs.mkdirSync(process.env.UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.UPLOAD_DIR, 'test-id.txt'), 'Test fixture - not identity evidence');
  return Number(q.run("INSERT INTO verifications(user_id,id_type,id_number,dob_declared,id_file,selfie_file,status) VALUES(?,'passport','TEST-ONLY',?,'test-id.txt','test-id.txt','approved')", user.id, dob).lastInsertRowid);
}
async function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
let child, base, log = '';
async function start(env = {}) {
  const port = await freePort(); base = 'http://127.0.0.1:'+port;
  child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname,'..'), env: { ...process.env, PORT: String(port), CORS_ORIGIN:'*', TURN_URLS:'', TURN_SECRET:'', RTC_ICE_SERVERS:'', RTC_FORCE_RELAY:'false', ...env }, stdio:['ignore','pipe','pipe'] });
  child.stdout.on('data', d=>{log+=d;}); child.stderr.on('data',d=>{log+=d;});
  for (let i=0;i<100;i++) {
    if (child.exitCode !== null) throw new Error('Server failed: '+log);
    try { if ((await fetch(base+'/api/health')).ok) return base; } catch {}
    await new Promise(r=>setTimeout(r,100));
  }
  throw new Error('Server startup timeout '+log);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const done = new Promise(resolve=>child.once('exit',resolve)); child.kill('SIGTERM'); await done; child=null;
}
async function request(url, account, body, method) {
  const response = await fetch(base+url, {method:method || (body===undefined?'GET':'POST'), headers:{'Content-Type':'application/json',...(account?{Authorization:'Bearer '+account.token}:{})}, body:body===undefined?undefined:JSON.stringify(body)});
  return { status:response.status, data:await response.json() };
}
async function cleanup() { await stop(); db.close(); fs.rmSync(dir,{recursive:true,force:true}); }
module.exports={dir,db,q,user,live,document,admin,freePort,start,stop,request,cleanup,get base(){return base;},get log(){return log;}};
