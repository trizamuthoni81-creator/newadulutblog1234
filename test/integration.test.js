'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {io}=require('socket.io-client');
const h=require('./harness');
const model=h.user('Streamer','model'), client=h.user('Viewer'), outsider=h.user('Unpaid'), otherModel=h.user('OtherStreamer','model');
const lid=h.live(model), otherLive=h.live(otherModel);
const sockets=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function event(socket,name,ms=4000){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{socket.off(name,handler);reject(new Error('Timed out '+name));},ms);const handler=data=>{clearTimeout(timer);resolve(data);};socket.once(name,handler);});}
async function connect(user){const s=io(h.base,{auth:{token:user.token},transports:['websocket'],reconnection:false});sockets.push(s);await event(s,'connect');return s;}
async function join(s,id){const joined=event(s,'live_joined');s.emit('join_live',{live_id:id});return joined;}
before(()=>h.start());
after(async()=>{sockets.forEach(s=>s.disconnect());await h.cleanup();});
test('admin wallet funding buys one durable ticket with exactly one credit and fee',async()=>{
  let r=await h.request('/api/admin/users/'+client.id+'/wallet',h.admin,{amount_cents:15000});assert.equal(r.status,200);
  const responses=await Promise.all(Array.from({length:12},()=>h.request('/api/client/lives/'+lid+'/access',client,{})));
  assert.ok(responses.every(r=>r.status===200));assert.equal(responses.filter(r=>r.data.paid_cents===15000).length,1);
  assert.equal(h.q.get('SELECT wallet_cents w FROM users WHERE id=?',client.id).w,0);
  assert.equal(h.q.get('SELECT COUNT(*) c FROM live_access WHERE live_id=? AND user_id=?',lid,client.id).c,1);
  assert.equal(h.q.get("SELECT COUNT(*) c FROM transactions WHERE user_id=? AND kind='live_ticket'",client.id).c,1);
  assert.equal(h.q.get('SELECT wallet_cents w FROM users WHERE id=?',model.id).w,12000);
  r=await h.request('/api/client/lives/'+lid+'/access',client);assert.equal(r.data.access,true);
  r=await h.request('/api/client/lives/'+lid+'/access',client,{});assert.equal(r.data.already,true);
});
test('unfunded and unverified users cannot buy or obtain tickets',async()=>{
  assert.equal((await h.request('/api/client/lives/'+lid+'/access',outsider,{})).status,402);
  const unverified=h.user('NoVerification','client',0);
  assert.equal((await h.request('/api/client/lives/'+lid+'/access',unverified,{})).status,403);
  assert.equal((await h.request('/api/client/lives/'+lid+'/access',unverified)).status,403);
});
test('failure writing ticket rolls back wallet and earnings without changing schema',async()=>{
  const buyer=h.user('RollbackBuyer');h.q.run('UPDATE users SET wallet_cents=15000 WHERE id=?',buyer.id);
  h.db.exec(`CREATE TRIGGER test_fail_ticket BEFORE INSERT ON live_access WHEN NEW.user_id=${buyer.id} BEGIN SELECT RAISE(ABORT,'Injected ticket failure'); END;`);
  assert.equal((await h.request('/api/client/lives/'+lid+'/access',buyer,{})).status,500);
  assert.equal(h.q.get('SELECT wallet_cents w FROM users WHERE id=?',buyer.id).w,15000);
  assert.equal(h.q.get('SELECT wallet_cents w FROM users WHERE id=?',model.id).w,12000);
  h.db.exec('DROP TRIGGER test_fail_ticket');
});
test('free admin grant and subscriber ticket survive zero balance and subscription cancellation',async()=>{
  const free=h.live(model,0), subscriber=h.user('Subscriber');
  h.q.run('INSERT INTO subscriptions(model_id,client_id,price_cents) VALUES(?,?,100)',model.id,subscriber.id);
  assert.equal((await h.request('/api/client/lives/'+free+'/access',subscriber)).data.access,true);
  const s=await connect(subscriber);await join(s,free);s.disconnect();
  h.q.run("UPDATE subscriptions SET status='cancelled' WHERE client_id=?",subscriber.id);
  assert.equal((await h.request('/api/client/lives/'+free+'/access',subscriber,{})).data.already,true);
  h.q.run('INSERT INTO live_access(live_id,user_id,paid_cents) VALUES(?,?,0)',free,outsider.id);
  assert.equal((await h.request('/api/client/lives/'+free+'/access',outsider,{})).data.already,true);
});
test('tickets and active live ID survive backend restart without recharge',async()=>{
  await h.stop();await h.start();
  assert.equal((await h.request('/api/client/lives/'+lid+'/access',client)).data.access,true);
  assert.equal((await h.request('/api/model/lives/go-live',model,{})).data.live_id,lid);
});
test('RTC config requires authentication and does not cache credentials',async()=>{
  assert.equal((await h.request('/api/rtc/config')).status,401);
  assert.equal((await h.request('/api/rtc/config',client)).data.turnConfigured,false);
  const r=await fetch(h.base+'/api/rtc/config',{headers:{Authorization:'Bearer '+client.token}});assert.equal(r.headers.get('cache-control'),'no-store');
});
test('room authorization, targeted signaling, role checks, malformed packets, counts and cleanup',async()=>{
  const a=await connect(model),v=await connect(client),x=await connect(outsider),b=await connect(otherModel);
  await join(a,lid);await join(v,lid);await join(b,otherLive);
  const error=event(x,'error_msg');x.emit('join_live',{live_id:lid});assert.match((await error).error,/Payment/);
  let leak=0; x.on('webrtc_offer',()=>leak++);b.on('webrtc_offer',()=>leak++);v.on('webrtc_offer',()=>leak++);
  const payload={to:v.id,sdp:{type:'offer',sdp:'test'},session:'test-generation'};
  const directed=event(v,'webrtc_offer');a.emit('webrtc_offer',payload);const received=await directed;assert.equal(received.from,a.id);assert.equal(received.session,'test-generation');
  await sleep(100);assert.equal(leak,1);
  v.emit('webrtc_offer',{...payload,to:a.id});a.emit('webrtc_offer',{...payload,to:b.id});
  for(const eventName of ['webrtc_offer','webrtc_answer','webrtc_ice','chat','join_live'])a.emit(eventName,null);
  await sleep(200);assert.equal(leak,1);assert.equal((await h.request('/api/health')).status,200);
  const count=event(v,'viewer_count');a.disconnect();assert.equal((await count).count,1);
  const replacement=await connect(model);const existing=event(replacement,'existing_viewers');await join(replacement,lid);assert.ok((await existing).viewers.includes(v.id));
  const left=event(replacement,'viewer_left');v.disconnect();assert.ok((await left).socketId);
  replacement.disconnect();x.disconnect();b.disconnect();
});
test('broadcaster absence beyond the old 90-second cutoff keeps the same live and ticket', {timeout:105000},async()=>{
  const a=await connect(model);await join(a,lid);a.disconnect();await sleep(92000);
  assert.equal(h.q.get('SELECT status FROM lives WHERE id=?',lid).status,'live');
  assert.equal((await h.request('/api/client/lives/'+lid+'/access',client)).data.access,true);
  const back=await connect(model);await join(back,lid);back.disconnect();
});
test('verification listing includes approved, missing-document and revoked users; admin can reverse status',async()=>{
  h.document(client);const doc=h.document(model);
  let r=await h.request('/api/admin/verifications',h.admin);assert.ok(r.data.verifications.some(v=>v.user_id===outsider.id && v.id===null));
  assert.ok(r.data.verifications.some(v=>v.user_id===client.id && v.verified===1));
  const s=await connect(client);await join(s,lid);const disconnected=event(s,'disconnect');
  r=await h.request('/api/admin/users/'+client.id+'/verification',h.admin,{verified:false});assert.equal(r.status,200);await disconnected;
  assert.equal(h.q.get('SELECT verified FROM users WHERE id=?',client.id).verified,0);
  assert.equal((await h.request('/api/admin/users/'+client.id+'/verification',h.admin,{verified:true})).status,200);
  assert.equal((await h.request('/api/client/lives/'+lid+'/access',client)).data.access,true);
  assert.equal((await h.request('/api/admin/users/'+outsider.id+'/verification',h.admin,{verified:true})).status,400);
  assert.equal((await h.request('/api/admin/users/'+client.id+'/verification',outsider,{verified:false})).status,403);
  r=await h.request('/api/admin/verifications/'+doc+'/decide',h.admin,{decision:'rejected'});assert.equal(r.status,200);
  assert.equal(h.q.get('SELECT verified FROM users WHERE id=?',model.id).verified,0);
  assert.equal(h.q.get('SELECT status FROM lives WHERE id=?',lid).status,'ended');
  assert.equal((await h.request('/api/admin/verifications/'+doc+'/decide',h.admin,{decision:'approved'})).status,200);
});
test('admin cannot manually approve mismatched or underage identity evidence',async()=>{
  const u=h.user('Mismatched','client',0),doc=h.document(u,'2020-01-01');
  assert.equal((await h.request('/api/admin/verifications/'+doc+'/decide',h.admin,{decision:'approved'})).status,400);
  assert.equal((await h.request('/api/admin/users/'+u.id+'/verification',h.admin,{verified:true})).status,400);
});
test('explicitly ending a live revokes room entry but preserves historical purchase record',async()=>{
  const newLive=h.live(model);h.q.run('INSERT INTO live_access(live_id,user_id,paid_cents) VALUES(?,?,0)',newLive,client.id);
  assert.equal((await h.request('/api/model/lives/'+newLive+'/end',model,{})).status,200);
  assert.equal((await h.request('/api/client/lives/'+newLive+'/access',client)).status,404);
  assert.ok(h.q.get('SELECT id FROM live_access WHERE live_id=? AND user_id=?',newLive,client.id));
});
