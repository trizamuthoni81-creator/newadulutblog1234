'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {buildRTCConfig}=require('../src/rtc');
test('unconfigured mode exposes STUN only, never shared public TURN passwords',()=>{
  const c=buildRTCConfig(7,{});assert.equal(c.turnConfigured,false);assert.equal(c.iceTransportPolicy,'all');assert.equal(c.iceServers.length,1);
});
test('coturn credentials are user-bound, expiring HMAC-SHA1 credentials',()=>{
  const c=buildRTCConfig(7,{TURN_URLS:'turn:relay.example:3478,turns:relay.example:443?transport=tcp',TURN_SECRET:'unit-test-secret',TURN_TTL_SECONDS:'3600'},1000000);
  assert.equal(c.turnConfigured,true);assert.equal(c.iceServers[1].username,'4600:7');
  assert.equal(c.iceServers[1].credential,crypto.createHmac('sha1','unit-test-secret').update('4600:7').digest('base64'));
  assert.equal(c.expiresAt,4600000);assert.ok(!JSON.stringify(c).includes('unit-test-secret'));
});
test('static provider credentials and relay-only policy work',()=>{
  const c=buildRTCConfig(1,{TURN_URLS:'turn:relay.example:3478',TURN_USERNAME:'a',TURN_CREDENTIAL:'b',RTC_FORCE_RELAY:'true'});
  assert.equal(c.iceTransportPolicy,'relay');assert.equal(c.iceServers[1].credential,'b');
});
test('invalid/missing TURN credentials fail explicitly instead of silent blank video',()=>{
  for(const env of [{TURN_URLS:'turn:relay.example:3478'},{RTC_FORCE_RELAY:'true'},{RTC_ICE_SERVERS:'not-json'},{RTC_ICE_SERVERS:'[]'},{RTC_ICE_SERVERS:'[{"urls":"https://invalid"}]'},{RTC_ICE_SERVERS:'[{"urls":"turn:relay.example"}]'}])assert.throws(()=>buildRTCConfig(1,env));
});
test('provider JSON ICE configuration preserves transport URLs',()=>{
  const c=buildRTCConfig(1,{RTC_ICE_SERVERS:JSON.stringify([{urls:['turns:relay.example:443?transport=tcp'],username:'x',credential:'y'}])});
  assert.equal(c.turnConfigured,true);assert.equal(c.iceServers[0].urls[0],'turns:relay.example:443?transport=tcp');
});
