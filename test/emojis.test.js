import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationEmojis } from '../src/emojis.js';
import { listReminders, deliverReminders } from '../src/reminders.js';
import { validateSchedule } from '../src/schedule.js';
import { stormResponse } from '../src/interactions.js';
import { database, sourceSchedule, seed } from './helpers.js';

test('application emojis are cached and used in reminder text, menus and DMs', async t => {
  const DB = database();
  const schedule = validateSchedule(sourceSchedule);
  await seed(DB, schedule);
  const now = schedule.epoch + 30000;
  for (const [id, location] of [['general', null], ['region', 'howling-woods']]) {
    await DB.prepare("INSERT INTO reminders (id,user_id,dm_channel,location,repeating,next_at,status,lease_until,last_error,created_at) VALUES(?, 'user', 'dm', ?, 0, ?, 'active', 0, NULL, 0)").bind(id, location, schedule.epoch).run();
  }
  const env = { DB, DISCORD_APPLICATION_ID: 'emoji-test', DISCORD_BOT_TOKEN: 'test' };
  let lookups = 0;
  const messages = [];
  const responses = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url.endsWith('/emojis')) {
      lookups++;
      return Response.json({ items: [{ id: '100', name: 'soulstorm' }, { id: '200', name: 'howling_woods' }, { id: '300', name: 'singers_meadow' }] });
    }
    if (init.body instanceof FormData) {
      responses.push(JSON.parse(init.body.get('payload_json')));
      return Response.json({ id: 'response' });
    }
    messages.push(JSON.parse(init.body));
    return Response.json({ id: 'sent' });
  });
  const list = await listReminders(env, 'user');
  assert.match(list.content, /<:soulstorm:100> Any storm/);
  assert.match(list.content, /<:howling_woods:200> Howling Woods/);
  const options = list.components[0].components[0].options;
  assert.equal(options.find(option => option.value === 'region').emoji.id, '200');
  await deliverReminders(env, now);
  assert.ok(messages.some(message => message.content.startsWith('<:soulstorm:100> ')));
  assert.ok(messages.some(message => message.content.startsWith('<:howling_woods:200> ')));
  let displayTime = now;
  t.mock.method(Date, 'now', () => displayTime);
  await stormResponse(env, { application_id: 'emoji-test', token: 'test' }, 'Europe/London');
  assert.match(responses[0].components[1].content, /^<:soulstorm:100> Storm active\n/);
  assert.match(responses[0].components[1].content, /<:howling_woods:200> Howling Woods ends/);
  assert.match(responses[0].components[1].content, /<:singers_meadow:300> Singers Meadow starts at/);
  displayTime = schedule.epoch + schedule.duration;
  await stormResponse(env, { application_id: 'emoji-test', token: 'test' }, 'Europe/London');
  assert.match(responses[1].components[1].content, /^<:soulstorm:100> No active storm/);
  assert.equal(responses[1].components[1].content.split('\n').length, 2);
  assert.match(responses[1].components[1].content, /<:singers_meadow:300> Singers Meadow starts at/);
  assert.equal(lookups, 1);
});

test('emoji lookup failures leave reminder text and menus usable', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 503 }));
  const env = { DISCORD_APPLICATION_ID: 'unavailable-emoji-test', DISCORD_BOT_TOKEN: 'test' };
  assert.deepEqual(await applicationEmojis(env), {});
});
