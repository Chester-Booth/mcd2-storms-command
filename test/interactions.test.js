import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { imageDescription } from '../src/interactions.js';
import { database, seed, sourceSchedule } from './helpers.js';
import { validateSchedule } from '../src/schedule.js';

async function signed(body) {
  const keys=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);
  const raw=JSON.stringify(body),timestamp=String(Math.floor(Date.now()/1000));
  const signature=Buffer.from(await crypto.subtle.sign('Ed25519',keys.privateKey,new TextEncoder().encode(timestamp+raw))).toString('hex');
  const publicKey=Buffer.from(await crypto.subtle.exportKey('raw',keys.publicKey)).toString('hex');
  return {publicKey,request:new Request('https://example.com/interactions',{method:'POST',headers:{'X-Signature-Ed25519':signature,'X-Signature-Timestamp':timestamp},body:raw})};
}

test('public command defers promptly and posts an actual PNG above live Discord text', async t=>{
  const DB=database();await seed(DB,validateSchedule(sourceSchedule));
  const interaction={type:2,id:'100',application_id:'app',token:'test',member:{user:{id:'user'}},data:{name:'storms'}};
  const {request,publicKey}=await signed(interaction);
  const updates=[];t.mock.method(globalThis,'fetch',async(url,init)=>{updates.push(init.body);return Response.json({id:'sent'});});
  const pending=[];
  const response=await worker.fetch(request,{DB,DISCORD_APPLICATION_ID:'app',DISCORD_PUBLIC_KEY:publicKey,STORM_USER_LIMIT:{limit:async()=>({success:true})}},{waitUntil:p=>pending.push(p)});
  assert.deepEqual(await response.json(),{type:5,data:{flags:0}});
  await Promise.all(pending);
  assert.equal(updates.length,1);
  assert.ok(updates[0] instanceof FormData);
  const payload=JSON.parse(updates[0].get('payload_json'));
  assert.equal(payload.flags,32768);
  assert.equal(payload.components[0].type,12);
  assert.equal(payload.components[1].type,10);
  assert.match(payload.components[1].content, /starts at <t:\d+:t>/);
  assert.equal(payload.components[2].components[0].custom_id,'refresh:Europe/London');
  const bytes=new Uint8Array(await updates[0].get('files[0]').arrayBuffer());
  assert.deepEqual([...bytes.slice(0,8)],[137,80,78,71,13,10,26,10]);
});

test('settings defer privately and save only for their user',async t=>{
  const DB=database();const interaction={type:2,id:'101',application_id:'app',token:'test',user:{id:'user'},data:{name:'storm',options:[{name:'settings',type:1,options:[{name:'timezone',value:'America/New_York'}]}]}};
  const {request,publicKey}=await signed(interaction);const pending=[];
  t.mock.method(globalThis,'fetch',async()=>Response.json({id:'sent'}));
  const response=await worker.fetch(request,{DB,DISCORD_APPLICATION_ID:'app',DISCORD_PUBLIC_KEY:publicKey},{waitUntil:p=>pending.push(p)});
  assert.deepEqual(await response.json(),{type:5,data:{flags:64}});await Promise.all(pending);
  assert.equal((await DB.prepare('SELECT timezone FROM preferences WHERE user_id=?').bind('user').first()).timezone,'America/New_York');
  assert.equal(await DB.prepare('SELECT timezone FROM preferences WHERE user_id=?').bind('other').first(),null);
});

test('unsigned and wrong-application requests cannot run commands',async()=>{
  const unsigned=new Request('https://example.com/interactions',{method:'POST',body:'{"type":2}'});
  assert.equal((await worker.fetch(unsigned,{},{})).status,401);
  const {request,publicKey}=await signed({type:2,application_id:'other'});
  assert.equal((await worker.fetch(request,{DISCORD_APPLICATION_ID:'app',DISCORD_PUBLIC_KEY:publicKey},{})).status,401);
});


test('image descriptions include active status and every upcoming storm with its times', () => {
  const schedule=validateSchedule(sourceSchedule);
  const description=imageDescription(schedule,schedule.epoch,'Europe/London');
  assert.match(description,/Active: Howling Woods, ends 00:20/);
  assert.match(description,/Next seven storms:/);
  assert.ok(description.includes('Frozen Highlands'));
  assert.ok(description.includes('Honeycomb Fields'));
  assert.ok(description.includes('04:40 to 05:00'));
  assert.ok(description.length <= 1024);
  assert.match(imageDescription(schedule,schedule.epoch+schedule.duration,'Europe/London'),/No active storm/);
});

test('storm commands and Refresh share a user limit and reject privately before doing work', async () => {
  const keys = [];
  const env = {
    DISCORD_APPLICATION_ID: 'app',
    STORM_USER_LIMIT: { limit: async ({ key }) => { keys.push(key); return { success: false }; } },
    STORM_REFRESH_LIMIT: { limit: () => assert.fail('User denial must skip the message counter') },
  };
  for (const interaction of [
    { type: 2, user: { id: 'user' }, data: { name: 'storms' } },
    { type: 3, member: { user: { id: 'user' } }, message: { id: 'message' }, data: { custom_id: 'refresh:Europe/London' } },
  ]) {
    const { request, publicKey } = await signed({ ...interaction, application_id: 'app' });
    const response = await worker.fetch(request, { ...env, DISCORD_PUBLIC_KEY: publicKey }, {
      waitUntil: () => assert.fail('Rejected requests must not touch the DB or render images'),
    });
    assert.deepEqual(await response.json(), { type: 4, data: {
      flags: 64, content: 'Please wait a few seconds before trying again', allowed_mentions: { parse: [] },
    } });
  }
  assert.deepEqual(keys, ['soulstorms:app:user:user', 'soulstorms:app:user:user']);
});

test('Refresh has a shared message limit across different users', async () => {
  const userKeys = [], messageKeys = [];
  for (const id of ['alice', 'bob']) {
    const { request, publicKey } = await signed({
      type: 3, application_id: 'app', user: { id }, message: { id: 'shared-message' },
      data: { custom_id: 'refresh:Europe/London' },
    });
    const response = await worker.fetch(request, {
      DISCORD_APPLICATION_ID: 'app', DISCORD_PUBLIC_KEY: publicKey,
      STORM_USER_LIMIT: { limit: async ({ key }) => { userKeys.push(key); return { success: true }; } },
      STORM_REFRESH_LIMIT: { limit: async ({ key }) => { messageKeys.push(key); return { success: false }; } },
    }, { waitUntil: () => assert.fail('A blocked refresh must leave the original message untouched') });
    const body = await response.json();
    assert.equal(body.type, 4);
    assert.equal(body.data.flags, 64);
  }
  assert.notEqual(userKeys[0], userKeys[1]);
  assert.deepEqual(messageKeys, ['soulstorms:app:message:shared-message', 'soulstorms:app:message:shared-message']);
});
