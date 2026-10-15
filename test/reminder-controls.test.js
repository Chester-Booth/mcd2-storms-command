import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshot, validateSchedule, nextReminder, syncSchedule } from '../src/schedule.js';
import { createReminder, deliverReminders, controlReminder, listReminders } from '../src/reminders.js';
import { processInteraction, imageDescription } from '../src/interactions.js';
import { database, sourceSchedule, seed, page } from './helpers.js';
const schedule = validateSchedule(sourceSchedule);
const minute = 60000;

test('location filtering keeps seven appearances aligned to the global rotation', () => {
  const filtered = snapshot(schedule, schedule.epoch + minute, 'frozen-highlands');
  assert.equal(filtered.current, null);
  assert.equal(filtered.upcoming.length, 7);
  for (const [i, event] of filtered.upcoming.entries()) {
    assert.equal(event.area.id, 'frozen-highlands');
    assert.equal(event.start, schedule.epoch + (5 + i * 7) * schedule.cadence);
  }
  const start = filtered.upcoming[0].start;
  assert.equal(snapshot(schedule, start, 'frozen-highlands').current.start, start);
  assert.equal(snapshot(schedule, start + schedule.duration, 'frozen-highlands').current, null);
  const alt = imageDescription(schedule, schedule.epoch, 'Europe/London', 'frozen-highlands');
  assert.ok(!alt.includes('Howling Woods'));
  assert.match(alt, /2 Jan/);
  assert.throws(() => snapshot(schedule, start, 'removed'), /no longer/);
});

test('advance notice skips starts too close for the full lead time', () => {
  const after = schedule.epoch + 15 * minute;
  const next = nextReminder(schedule, after, null, 30);
  assert.equal(next.start, schedule.epoch + 80 * minute);
  assert.equal(next.notifyAt, schedule.epoch + 50 * minute);
  assert.equal(nextReminder(schedule, after, null, 0).start, schedule.epoch + 40 * minute);
});

test('advance reminders deliver once, retain notice when repeated and carry DM controls', async t => {
  const DB = database(); await seed(DB, schedule);
  const now = schedule.epoch + 35 * minute;
  const env = { DB, DISCORD_BOT_TOKEN: 'test' };
  for (const [id, repeating] of [['once', 0], ['repeat', 1]]) {
    await DB.prepare("INSERT INTO reminders(id,user_id,dm_channel,repeating,next_at,status,created_at,before_minutes) VALUES(?,'owner','dm',?,?,'active',?,5)")
      .bind(id, repeating, now, now).run();
  }
  const messages = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => { messages.push(JSON.parse(init.body)); return Response.json({ id: 'sent' }); });
  await deliverReminders(env, now + 30000);
  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /starts in \*\*Singers Meadow\*\* <t:/);
  assert.ok(!messages[0].content.endsWith('.'));
  assert.equal(messages[0].components[0].components[0].custom_id, 'reminder:again:once');
  assert.equal(messages[1].components[0].components[0].custom_id, 'reminder:stop:repeat');
  const repeating = await DB.prepare("SELECT * FROM reminders WHERE id='repeat'").first();
  assert.equal(repeating.next_at, schedule.epoch + 75 * minute);
  await deliverReminders(env, now + minute);
  assert.equal(messages.length, 2);
  t.mock.method(Date, 'now', () => now + minute);
  assert.match(await controlReminder(env, 'other', 'again', 'once'), /no longer available/);
  assert.match(await controlReminder(env, 'owner', 'again', 'once'), /5 minutes before/);
  const rearmed = await DB.prepare("SELECT * FROM reminders WHERE id='once'").first();
  assert.equal(rearmed.status, 'active');
  assert.equal(rearmed.before_minutes, 5);
  assert.equal(rearmed.next_at, schedule.epoch + 75 * minute);
  assert.match(await controlReminder(env, 'owner', 'again', 'once'), /already active/);
  await controlReminder(env, 'other', 'stop', 'repeat');
  assert.equal((await DB.prepare("SELECT status FROM reminders WHERE id='repeat'").first()).status, 'active');
  assert.match(await controlReminder(env, 'owner', 'stop', 'repeat'), /cancelled/);
  assert.equal((await DB.prepare("SELECT status FROM reminders WHERE id='repeat'").first()).status, 'cancelled');
  const list = await listReminders(env, 'owner');
  assert.match(list.content, /5 min before/);
  assert.ok(list.components.every(row => row.components.every(component => component.type !== 2)));
});

test('creation validates the notice range and confirms the actual notification and start', async t => {
  const DB = database(); await seed(DB, schedule);
  const now = schedule.epoch + 15 * minute;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ id: 'dm' }));
  const env = { DB, DISCORD_BOT_TOKEN: 'test' };
  for (const value of [-1, 31, 1.5]) await assert.rejects(createReminder(env, { id: 'bad' }, 'owner', null, false, value), /0 and 30/);
  const message = await createReminder(env, { id: 'new' }, 'owner', null, false, 30);
  assert.match(message, /30 minutes before/);
  assert.match(message, /Starts at <t:/);
  assert.ok(!message.endsWith('.'));
  assert.equal((await DB.prepare("SELECT next_at FROM reminders WHERE id='new'").first()).next_at, schedule.epoch + 50 * minute);
  await assert.rejects(createReminder(env, { id: 'duplicate' }, 'owner', null, false, 30), /already have/);
});

test('a changed source recalculates the notification time with its advance notice', async t => {
  const DB = database(); await seed(DB, schedule);
  await DB.prepare("INSERT INTO reminders(id,user_id,dm_channel,repeating,next_at,status,created_at,before_minutes) VALUES('lead','owner','dm',1,1,'active',0,10)").run();
  const changed = { ...sourceSchedule, cadenceSeconds: 3600 };
  const now = schedule.epoch + minute;
  t.mock.method(globalThis, 'fetch', async () => new Response(page(changed)));
  await syncSchedule({ DB }, now, true);
  assert.equal((await DB.prepare("SELECT next_at FROM reminders WHERE id='lead'").first()).next_at, schedule.epoch + 50 * minute);
});

test('filtered Refresh preserves location and DM controls check the requesting user', async t => {
  const DB = database(); await seed(DB, schedule);
  const updates = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => { updates.push(init.body); return Response.json({ id: 'sent' }); });
  await processInteraction({ DB }, { type: 3, application_id: 'app', token: 'test', user: { id: 'user' }, data: { custom_id: 'refresh:Europe/London:frozen-highlands' } });
  const payload = JSON.parse(updates[0].get('payload_json'));
  assert.equal(payload.components[2].components[0].custom_id, 'refresh:Europe/London:frozen-highlands');
  assert.match(payload.components[0].items[0].description, /Soul Storms in Frozen Highlands/);
  assert.ok(!payload.components[1].content.includes('Howling Woods'));
  await processInteraction({ DB }, { type: 3, application_id: 'app', token: 'test', user: { id: 'user' }, data: { custom_id: 'reminder:stop:missing' } });
  assert.equal(JSON.parse(updates[1]).content, 'This reminder is no longer available');
});
