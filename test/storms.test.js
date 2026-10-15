import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSchedule, validateSchedule, snapshot, nextStorm, syncSchedule, readSchedule, nextScheduleCheck, SOURCE } from '../src/schedule.js';
import { timezone, timezoneChoices } from '../src/timezone.js';
import { verifyRequest } from '../src/discord.js';
import { createReminder, deliverReminders } from '../src/reminders.js';
import { processInteraction } from '../src/interactions.js';
import { database, sourceSchedule, page, seed } from './helpers.js';
const schedule = validateSchedule(sourceSchedule);

test('source parser reads streamed props and rejects missing, broken or unsafe schedules', () => {
  assert.deepEqual(parseSchedule(page(sourceSchedule)), schedule);
  const data = JSON.stringify(sourceSchedule);
  const streamed = `<script>self.__next_f.push(${JSON.stringify([1, '"storm":'+data.slice(0,40)])})</script><script>self.__next_f.push(${JSON.stringify([1, data.slice(40)])})</script>`;
  assert.deepEqual(parseSchedule(streamed), schedule);
  assert.throws(() => parseSchedule('<html>Source changed</html>'));
  assert.throws(() => parseSchedule(page({ ...sourceSchedule, cadenceSeconds: 0 })));
  assert.throws(() => parseSchedule(page({ ...sourceSchedule, areas: [{ name: 'Bad', href: 'https://evil.example' }] })));
});

test('storm boundaries, seven upcoming entries and location reminders follow UTC', () => {
  assert.equal(snapshot(schedule, schedule.epoch).current.area.id, 'howling-woods');
  assert.equal(snapshot(schedule, schedule.epoch + schedule.duration - 1).current.area.id, 'howling-woods');
  assert.equal(snapshot(schedule, schedule.epoch + schedule.duration).current, null);
  assert.equal(snapshot(schedule, schedule.epoch + schedule.cadence).current.area.id, 'singers-meadow');
  assert.equal(snapshot(schedule, schedule.epoch).upcoming.length, 7);
  assert.equal(nextStorm(schedule, schedule.epoch, 'howling-woods').start, schedule.epoch + 7 * schedule.cadence);
  assert.equal(nextStorm(schedule, schedule.epoch, 'removed'), null);
  assert.equal(snapshot(schedule, schedule.epoch - 1000).upcoming[0].start, schedule.epoch);
});

test('timezone aliases, city search and UK daylight saving', () => {
  assert.equal(timezone('uk'), 'Europe/London');
  assert.throws(() => timezone('made-up'));
  assert.equal(timezoneChoices('new york')[0].value, 'America/New_York');
  const format = date => new Intl.DateTimeFormat('en-GB', { timeZone: timezone(), hour: '2-digit', minute: '2-digit' }).format(new Date(date));
  assert.equal(format('2026-01-01T12:00:00Z'), '12:00');
  assert.equal(format('2026-07-01T12:00:00Z'), '13:00');
});

test('only valid fresh Discord signatures pass verification', async () => {
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign','verify']);
  const hex = data => Buffer.from(data).toString('hex');
  const publicKey = hex(await crypto.subtle.exportKey('raw', keys.publicKey));
  const timestamp = String(Math.floor(Date.now()/1000));
  const body = '{"type":1}';
  const signature = hex(await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(timestamp+body)));
  const request = new Request('https://example.com', {headers:{'X-Signature-Ed25519':signature,'X-Signature-Timestamp':timestamp}});
  assert.equal(await verifyRequest(request, body, publicKey),true);
  assert.equal(await verifyRequest(request, body+' ',publicKey),false);
  assert.equal(await verifyRequest(request,body,publicKey,Date.now()+10*60000),false);
});

test('source changes recalculate reminders, missing regions stop, failures keep last good data', async t => {
  const DB=database(); await seed(DB,schedule,0);
  await DB.prepare("INSERT INTO reminders (id,user_id,dm_channel,location,repeating,next_at,status,lease_until,last_error,created_at) VALUES('1','u','dm','howling-woods',1,1,'active',0,NULL,0)").run();
  await DB.prepare("INSERT INTO reminders (id,user_id,dm_channel,location,repeating,next_at,status,lease_until,last_error,created_at) VALUES('2','u','dm','singers-meadow',1,1,'active',0,NULL,0)").run();
  const changed={...sourceSchedule,cadenceSeconds:3600,areas:[sourceSchedule.areas[0]]};
  t.mock.method(globalThis,'fetch',async()=>new Response(page(changed)));
  const now=Date.now(); await syncSchedule({DB},now,true);
  assert.equal((await readSchedule({DB})).schedule.cadence,3600000);
  assert.equal((await DB.prepare("SELECT * FROM reminders WHERE id='1'").first()).next_at,nextStorm(validateSchedule(changed),now).start);
  assert.equal((await DB.prepare("SELECT * FROM reminders WHERE id='2'").first()).status,'failed');
  globalThis.fetch=async()=>new Response('Unavailable',{status:503});
  await syncSchedule({DB},now+1000,true);
  assert.equal((await readSchedule({DB})).schedule.cadence,3600000);
  assert.match((await readSchedule({DB})).last_error,/503/);
});

test('blocked DM channel creation does not activate reminders',async t=>{
  const DB=database();await seed(DB,schedule);
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({code:50007}),{status:403}));
  await assert.rejects(createReminder({DB,DISCORD_BOT_TOKEN:'test'},{id:'1'},'u',null,false),/No reminder was activated/);
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM reminders').first()).n,0);
});

test('one-off reminders fire once, repeating reminders advance, expired reminders do not send',async t=>{
  const DB=database();await seed(DB,schedule);
  const now=schedule.epoch+schedule.cadence*10+30000;
  for(const [id,repeat,due] of [['1',0,now-30000],['2',1,now-30000],['3',0,now-30000-schedule.cadence]]){
    await DB.prepare('INSERT INTO reminders (id,user_id,dm_channel,location,repeating,next_at,status,lease_until,last_error,created_at) VALUES(?,?,?,NULL,?,?,\'active\',0,NULL,0)').bind(id,'u','dm',repeat,due).run();
  }
  const messages=[];
  t.mock.method(globalThis,'fetch',async(url,init)=>{messages.push(JSON.parse(init.body));return Response.json({id:'sent'});});
  await deliverReminders({DB,DISCORD_BOT_TOKEN:'test'},now);
  assert.equal(messages.length,2);
  assert.equal((await DB.prepare("SELECT status FROM reminders WHERE id='1'").first()).status,'delivered');
  assert.equal((await DB.prepare("SELECT next_at FROM reminders WHERE id='2'").first()).next_at,nextStorm(schedule,now).start);
  assert.equal((await DB.prepare("SELECT status FROM reminders WHERE id='3'").first()).status,'failed');
  await deliverReminders({DB,DISCORD_BOT_TOKEN:'test'},now+1000);
  assert.equal(messages.length,2);
});

test('cancellation is restricted to the reminder owner',async t=>{
  const DB=database();await seed(DB,schedule);
  await DB.prepare("INSERT INTO reminders (id,user_id,dm_channel,location,repeating,next_at,status,lease_until,last_error,created_at) VALUES('1','owner','dm',NULL,1,1,'active',0,NULL,0)").run();
  t.mock.method(globalThis,'fetch',async()=>Response.json({id:'response'}));
  await processInteraction({DB},{id:'2',application_id:'app',token:'t',type:3,user:{id:'other'},data:{custom_id:'cancel-reminder',values:['1']}});
  assert.equal((await DB.prepare("SELECT status FROM reminders WHERE id='1'").first()).status,'active');
});


test('creating a reminder confirms privately without sending a test DM', async t => {
  const DB = database(); await seed(DB, schedule);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => { requests.push(url); return Response.json({ id: 'dm' }); });
  const content = await createReminder({ DB, DISCORD_BOT_TOKEN: 'test' }, { id: 'new' }, 'u', null, true);
  assert.deepEqual(requests, ['https://discord.com/api/v10/users/@me/channels']);
  assert.match(content, /^Confirmed, I'll remind you <t:\d+:R> when the next storm starts$/);
  assert.equal((await DB.prepare("SELECT status FROM reminders WHERE id='new'").first()).status, 'active');
});


test('source sync runs once in the minute before each storm, including a delayed cron', async t => {
  const DB=database(); const start=schedule.epoch;
  await seed(DB,schedule,start);
  const requests=[];
  t.mock.method(globalThis,'fetch',async url=>{requests.push(url);return new Response(page(sourceSchedule));});
  const env={DB};
  assert.equal(nextScheduleCheck(schedule,start),start+39*60000);
  await syncSchedule(env,start+38*60000); assert.equal(requests.length,0);
  await syncSchedule(env,start+39*60000+12000); assert.equal(requests.length,1);
  await syncSchedule(env,start+39*60000+45000); assert.equal(requests.length,1);
  await syncSchedule(env,start+40*60000); assert.equal(requests.length,1);
  await syncSchedule(env,start+79*60000); assert.equal(requests.length,2);
  await syncSchedule(env,start+121*60000); assert.equal(requests.length,3);
  assert.equal((await DB.prepare('SELECT next_check_at FROM sync_state').first()).next_check_at,start+159*60000);
});

test('unknown schedules retry hourly, alert once per outage and rearm after recovery', async t => {
  const DB=database(); const env={DB,DISCORD_BOT_TOKEN:'test',DISCORD_OWNER_ID:'owner'};
  const start=schedule.epoch; let sourceAvailable=false; let sourceCalls=0; let messages=0;
  t.mock.method(globalThis,'fetch',async (url,init)=>{
    if(url===SOURCE){sourceCalls++;return sourceAvailable?new Response(page(sourceSchedule)):new Response('Unavailable',{status:503});}
    if(url.endsWith('/users/@me/channels'))return Response.json({id:'dm'});
    messages++;assert.equal(JSON.parse(init.body).allowed_mentions.parse.length,0);return Response.json({id:'sent'});
  });
  assert.equal(await syncSchedule(env,start),false);
  await syncSchedule(env,start+60000);assert.equal(sourceCalls,1);assert.equal(messages,1);
  await syncSchedule(env,start+3600000);assert.equal(sourceCalls,2);assert.equal(messages,1);
  sourceAvailable=true;
  assert.equal(await syncSchedule(env,start+7200000),true);assert.equal(messages,1);
  assert.equal((await DB.prepare('SELECT outage_alerted FROM sync_state').first()).outage_alerted,0);
  sourceAvailable=false;
  const due=(await DB.prepare('SELECT next_check_at FROM sync_state').first()).next_check_at;
  assert.equal(await syncSchedule(env,due),true);assert.equal(messages,2);
  assert.ok((await readSchedule(env)).schedule);
});
