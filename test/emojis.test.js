import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationEmojis } from '../src/emojis.js';
import { listReminders, deliverReminders } from '../src/reminders.js';
import { validateSchedule } from '../src/schedule.js';
import { database, sourceSchedule, seed } from './helpers.js';

test('application emojis are cached and used in reminder text, menus and DMs', async t => {
  const DB = database();
  const schedule = validateSchedule(sourceSchedule);
  await seed(DB, schedule);
  const now = schedule.epoch + 30000;
  for (const [id, location] of [['general', null], ['region', 'howling-woods']]) {
    await DB.prepare("INSERT INTO reminders VALUES(?, 'user', 'dm', ?, 0, ?, 'active', 0, NULL, 0)").bind(id, location, schedule.epoch).run();
  }
  const env = { DB, DISCORD_APPLICATION_ID: 'emoji-test', DISCORD_BOT_TOKEN: 'test' };
  let lookups = 0;
  const messages = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url.endsWith('/emojis')) {
      lookups++;
      return Response.json({ items: [{ id: '100', name: 'soulstorm' }, { id: '200', name: 'howling_woods' }] });
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
  assert.equal(lookups, 1);
});

test('emoji lookup failures leave reminder text and menus usable', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 503 }));
  const env = { DISCORD_APPLICATION_ID: 'unavailable-emoji-test', DISCORD_BOT_TOKEN: 'test' };
  assert.deepEqual(await applicationEmojis(env), {});
});
