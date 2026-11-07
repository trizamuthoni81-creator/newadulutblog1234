'use strict';
// Browser regression uses synthetic camera/audio only. Optional local coturn enables
// real relay allocations and decoded-video checks; this is NOT a remote WAN test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {chromium} = require('playwright');
const express = require('express');
const h = require('./harness');
const model = h.user('BrowserStreamer','model'), viewer = h.user('BrowserViewer'), viewer2=h.user('SecondBrowserViewer');
h.document(model);h.document(viewer);
let browser, web, relay, relayLog='', frontend, base, liveId;
const errors=[], results=[];
const wait = ms=>new Promise(r=>setTimeout(r,ms));
async function check(name, fn){await fn();results.push(name);console.log('PASS '+name);}
async function authContext(account, mobile=false){
  const c=await browser.newContext({permissions:['camera','microphone'],viewport:mobile?{width:390,height:844}:{width:1366,height:900},reducedMotion:'reduce'});
  await c.addInitScript(({token,user,api})=>{
    if (!/^https?:$/.test(location.protocol)) return; // about:blank has an opaque origin
    localStorage.setItem('ab_token',token);localStorage.setItem('ab_user',JSON.stringify(user));localStorage.setItem('ab_api',api);localStorage.setItem('ab_age18','1');
    // Small synthetic stream keeps automated tests deterministic, not production quality policy.
    const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia=constraints=>original({...constraints,video:constraints.video?{width:{ideal:640},height:{ideal:480},frameRate:{ideal:15}}:false});
  },{token:account.token,user:account,api:base});
  await c.route('https://cdn.socket.io/**',route=>route.fulfill({path:path.join(__dirname,'../node_modules/socket.io/client-dist/socket.io.min.js'),contentType:'text/javascript'}));
  c.on('page',p=>{p.on('pageerror',e=>errors.push(e.message));p.on('console',msg=>{if(msg.type()==='warning')console.log('BROWSER WARNING '+msg.text());});});
  return c;
}
async function playing(page){
  await page.waitForFunction(()=>{const v=document.getElementById('viewer');return v && v.readyState>=2 && v.videoWidth>0 && v.currentTime>0;},{},{timeout:45000});
  const first=await page.evaluate(()=>document.getElementById('viewer').getVideoPlaybackQuality().totalVideoFrames);
  await page.waitForFunction(previous=>{const frames=document.getElementById('viewer').getVideoPlaybackQuality().totalVideoFrames;return frames>0&&frames!==previous;},first,{timeout:45000});
  const next=await page.evaluate(()=>document.getElementById('viewer').getVideoPlaybackQuality().totalVideoFrames);
  await page.waitForFunction(previous=>document.getElementById('viewer').getVideoPlaybackQuality().totalVideoFrames>previous,next,{timeout:15000});
}
async function candidateType(page){
  return page.evaluate(async()=>{
    const stats=await receiver.record.pc.getStats();let selected;
    stats.forEach(s=>{if(s.type==='transport'&&s.selectedCandidatePairId)selected=stats.get(s.selectedCandidatePairId);});
    if(!selected)stats.forEach(s=>{if(s.type==='candidate-pair'&&s.state==='succeeded'&&s.nominated)selected=s;});
    return selected?{local:stats.get(selected.localCandidateId)?.candidateType,remote:stats.get(selected.remoteCandidateId)?.candidateType}:{};
  });
}
async function main(){
  const app=express();app.use(express.static(path.join(__dirname,'../../frontend')));web=app.listen(0,'127.0.0.1');await new Promise(r=>web.once('listening',r));frontend='http://127.0.0.1:'+web.address().port;
  browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required']});
  base=await h.start();
  const mc=await authContext(model),vc=await authContext(viewer,true),v2c=await authContext(viewer2);
  const m=await mc.newPage(),v=await vc.newPage(),v2=await v2c.newPage();
  await check('studio starts camera, goes live and creates the original session',async()=>{
    await m.goto(frontend+'/model.html');await m.getByText('Go Live',{exact:true}).first().click();await m.getByRole('button',{name:'Start Camera'}).click();
    await m.waitForFunction(()=>typeof camStream!=='undefined'&&!!camStream);
    await m.locator('#title').fill('Browser transport test');await m.getByRole('button',{name:'🔴 Go Live',exact:true}).click();
    await m.waitForFunction(()=>typeof liveId!=='undefined'&&!!liveId);
    liveId=await m.evaluate(()=>liveId);assert.ok(liveId>0);
  });
  await check('admin funding → explicit ticket acceptance → decoded live video',async()=>{
    assert.equal((await h.request('/api/admin/users/'+viewer.id+'/wallet',h.admin,{amount_cents:15000})).status,200);
    await v.goto(frontend+'/watch.html?live='+liveId);await v.getByRole('button',{name:'Accept & Watch'}).click();await playing(v);
    assert.equal(h.q.get('SELECT wallet_cents w FROM users WHERE id=?',viewer.id).w,0);
  });
  await check('mobile player layout has no horizontal overflow and verification link stays visible',async()=>{
    assert.equal(await v.getByRole('link',{name:'Identity Verification',exact:true}).count(),1);
    assert.ok(await v.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  });
  await check('second paid viewer receives independent video; signaling is not mixed',async()=>{
    h.q.run('INSERT INTO live_access(live_id,user_id,paid_cents) VALUES(?,?,0)',liveId,viewer2.id);
    await v2.goto(frontend+'/watch.html?live='+liveId);await playing(v2);await playing(v);
    await m.waitForFunction(()=>document.getElementById('liveViewers').textContent==='2');
  });
  await check('viewer refresh re-enters with empty wallet and no ticket prompt',async()=>{
    await v.reload();await playing(v);assert.equal(await v.getByRole('button',{name:'Accept & Watch'}).count(),0);
    assert.equal(h.q.get("SELECT COUNT(*) c FROM transactions WHERE user_id=? AND kind='live_ticket'",viewer.id).c,1);
  });
  await check('chat flow remains functional',async()=>{
    await v.locator('#chatInput').fill('Browser regression hello');await v.getByRole('button',{name:'Send',exact:true}).click();
    await m.getByText('Browser regression hello',{exact:false}).waitFor();
  });
  await check('broadcaster refresh automatically recaptures and restores both viewers on the same live ID',async()=>{
    await m.reload();await m.waitForFunction(()=>!!document.getElementById('preview2')?.srcObject);await playing(v);await playing(v2);
    assert.equal(await m.evaluate(()=>liveId),liveId);assert.equal(h.q.get('SELECT status FROM lives WHERE id=?',liveId).status,'live');
  });
  await check('camera permission denial preserves live ID and Resume Camera recovers video',async()=>{
    await m.evaluate(()=>{
      camStream.getTracks().forEach(t=>t.stop());camStream=null;
      window.savedGetUserMedia=navigator.mediaDevices.getUserMedia;
      navigator.mediaDevices.getUserMedia=()=>Promise.reject(new DOMException('Test camera permission denied','NotAllowedError'));
      return resumeStudio();
    });
    await m.getByText('Camera could not resume:',{exact:false}).waitFor();
    assert.equal(h.q.get('SELECT status FROM lives WHERE id=?',liveId).status,'live');
    await m.evaluate(()=>{navigator.mediaDevices.getUserMedia=window.savedGetUserMedia;});
    await m.getByRole('button',{name:'Resume Camera / Retry Connection'}).click();await playing(v);
  });
  await check('viewer leave and return requires no additional money',async()=>{
    await v.goto(frontend+'/client.html');await v.goto(frontend+'/watch.html?live='+liveId);await playing(v);
    assert.equal(h.q.get('SELECT wallet_cents w FROM users WHERE id=?',viewer.id).w,0);
  });
  await check('viewer simulated network loss rejoins automatically',async()=>{
    await vc.setOffline(true);await wait(3000);await vc.setOffline(false);
    await v.evaluate(()=>{socket.io.engine.close();});await playing(v);
    await v.waitForFunction(()=>socket.connected);
  });
  await check('broadcaster simulated network loss resumes without ending the live',async()=>{
    await mc.setOffline(true);await wait(3000);await mc.setOffline(false);
    await m.evaluate(()=>{socket.io.engine.close();});await m.waitForFunction(()=>socket.connected);await playing(v);await playing(v2);
    assert.equal(h.q.get('SELECT status FROM lives WHERE id=?',liveId).status,'live');
  });
  await check('failed ICE peer is rebuilt and video frames resume',async()=>{
    await v.evaluate(()=>{receiver.record.pc.close();receiver.request();});await playing(v);
  });
  await check('user-selected sound playback works',async()=>{
    await v.getByRole('button',{name:'Play / Enable Sound'}).click();assert.equal(await v.locator('#viewer').evaluate(el=>el.muted),false);
  });
  await check('verification page remains accessible for an already-verified account',async()=>{
    const p=await vc.newPage();await p.goto(frontend+'/verify.html');await p.getByText('Identity verified.',{exact:false}).waitFor();await p.close();
  });
  await check('admin sees all identity entries and can unverify then verify from the UI',async()=>{
    const ac=await authContext(h.admin);const p=await ac.newPage();
    await p.goto(base+'/admin/');await p.evaluate(token=>{localStorage.setItem('ab_admin_token',token);},h.admin.token);
    // Admin app uses its original login flow and token storage key.
    await p.locator('#email').fill(h.admin.email);await p.locator('#pass').fill('isolated-test-admin-password');
    await p.getByRole('button',{name:/Sign In/}).click();await p.locator('[data-view="verifications"]').click();
    const row=p.locator('tr').filter({has:p.getByText('browserviewer@test.invalid',{exact:true})});
    await row.getByRole('button',{name:'Unverify',exact:true}).waitFor();
    p.on('dialog',d=>d.accept());await row.getByRole('button',{name:'Unverify',exact:true}).click();
    await row.getByRole('button',{name:'Verify',exact:true}).click();await row.getByRole('button',{name:'Unverify',exact:true}).waitFor();
    await ac.close();
  });
  if(process.env.TEST_SCREENSHOT_DIR){fs.mkdirSync(process.env.TEST_SCREENSHOT_DIR,{recursive:true});await m.screenshot({path:path.join(process.env.TEST_SCREENSHOT_DIR,'studio.png'),fullPage:true});}
  await mc.close();await vc.close();await v2c.close();await h.stop();
  if(process.env.TEST_WITH_TURN==='1'){
    const turnPort=await h.freePort();
    const secret='local-test-relay-secret';
    relay=spawn('turnserver',['-n','--no-cli','--no-tls','--no-dtls','--no-multicast-peers','--allow-loopback-peers','--use-auth-secret','--static-auth-secret='+secret,'--realm=local.test','--listening-ip=127.0.0.1','--relay-ip=127.0.0.1','--listening-port='+turnPort,'--min-port=52000','--max-port=52100','--relay-threads=1','--userdb='+path.join(h.dir,'turn-test.db'),'--log-file=stdout','--pidfile='+path.join(h.dir,'turn.pid')],{stdio:['ignore','pipe','pipe']});
    relay.stdout.on('data',d=>{relayLog+=d;});relay.stderr.on('data',d=>{relayLog+=d;});await wait(1500);
    if(relay.exitCode!==null)throw new Error('Local TURN failed: '+relayLog);
    for(const transport of ['udp','tcp']){
      await check('forced TURN '+transport.toUpperCase()+' uses real relay candidates and decodes video',async()=>{
        base=await h.start({TURN_URLS:'turn:127.0.0.1:'+turnPort+'?transport='+transport,TURN_SECRET:secret,RTC_FORCE_RELAY:'true'});
        const mc=await authContext(model),vc=await authContext(viewer);const m=await mc.newPage(),v=await vc.newPage();
        await m.goto(frontend+'/model.html');await v.goto(frontend+'/watch.html?live='+liveId);await playing(v);
        const candidates=await candidateType(v);assert.equal(candidates.local,'relay');assert.equal(candidates.remote,'relay');
        console.log('RELAY '+transport+' '+JSON.stringify(candidates));
        if(process.env.TEST_SCREENSHOT_DIR)await v.screenshot({path:path.join(process.env.TEST_SCREENSHOT_DIR,'viewer-'+transport+'.png'),fullPage:true});
        await mc.close();await vc.close();await h.stop();
      });
    }
  } else console.log('SKIPPED real local TURN allocation tests (set TEST_WITH_TURN=1 and install coturn)');
  await check('admin explicit end stops capture and studio can start a fresh broadcast afterward',async()=>{
    base=await h.start();const mc=await authContext(model),vc=await authContext(viewer);const m=await mc.newPage(),v=await vc.newPage();
    await m.goto(frontend+'/model.html');await v.goto(frontend+'/watch.html?live='+liveId);await playing(v);
    assert.equal((await h.request('/api/admin/lives/'+liveId+'/end',h.admin,{})).status,200);
    await m.waitForFunction(()=>camStream===null&&liveId===null);
    await m.getByRole('button',{name:'Start Camera'}).click();await m.waitForFunction(()=>!!camStream);
    await m.locator('#title').fill('Fresh session after explicit end');await m.getByRole('button',{name:'🔴 Go Live',exact:true}).click();
    await m.waitForFunction(()=>!!liveId);const fresh=await m.evaluate(()=>liveId);assert.notEqual(fresh,liveId);
    h.q.run('INSERT INTO live_access(live_id,user_id,paid_cents) VALUES(?,?,0)',fresh,viewer.id);
    await v.goto(frontend+'/watch.html?live='+fresh);await playing(v);
    await mc.close();await vc.close();await h.stop();
  });
  assert.deepEqual(errors,[],'No browser JavaScript runtime errors');
  console.log('PASS no browser JavaScript runtime errors');console.log('TOTAL '+(results.length+1)+' browser checks passed');
}
main().catch(e=>{console.error(e);console.error('SERVER LOG '+h.log);console.error('TURN LOG '+relayLog.slice(-7000));process.exitCode=1;}).finally(async()=>{
  if(browser)await browser.close();if(relay)relay.kill('SIGTERM');if(web)await new Promise(r=>web.close(r));await h.cleanup();
});
