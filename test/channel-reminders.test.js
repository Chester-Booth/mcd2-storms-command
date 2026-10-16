import test from 'node:test';
import assert from 'node:assert/strict';
import { createReminder, deliverReminders, controlReminder, listReminders } from '../src/reminders.js';
import { reminderDestination } from '../src/delivery.js';
import { processInteraction } from '../src/interactions.js';
import { validateSchedule } from '../src/schedule.js';
import { database, sourceSchedule, seed } from './helpers.js';
const schedule = validateSchedule(sourceSchedule);
const now = schedule.epoch + 34 * 60000;
const channelInteraction = id => ({ id, guild_id: '555', channel_id: '111', member: { user: { id: 'owner' }, permissions: '3072' }, app_permissions: '3072', data: {
  resolved: { channels: { '222': { id: '222', permissions: '3072', app_permissions: '3072' } } },
} });

test('current and selected channel reminders ping only the creator and preserve their destination', async t => {
  const DB = database(); await seed(DB, schedule);
  const env = { DB, DISCORD_BOT_TOKEN: 'test' };
  let time = now;
  t.mock.method(Date, 'now', () => time);
  const messages = [], lookups = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (init.method === 'GET') { lookups.push(url); return Response.json({ id: url.split('/').at(-1), guild_id: '555', type: 0 }); }
    messages.push({ url, body: JSON.parse(init.body) }); return Response.json({ id: 'sent' });
  });
  const confirmation = await createReminder(env, channelInteraction('current'), 'owner', null, false, 5, { where: 'channel' });
  assert.match(confirmation, /in <#111>/);
  await createReminder(env, channelInteraction('selected'), 'owner', null, true, 5, { channel: '222' });
  assert.equal(messages.length, 0);
  assert.equal(lookups.length, 2);
  const row = await DB.prepare("SELECT * FROM reminders WHERE id='selected'").first();
  assert.equal(row.dm_channel, '222');
  assert.equal(row.guild_id, '555');
  assert.equal(row.destination, 'channel');
  time = now + 60000;
  await deliverReminders(env, time);
  assert.deepEqual(messages.map(x => x.url.split('/').at(-2)).sort(), ['111', '222']);
  for (const { body } of messages) {
    assert.match(body.content, /^<@owner> A Soul Storm starts/);
    assert.deepEqual(body.allowed_mentions, { parse: [], users: ['owner'] });
  }
  await assert.rejects(createReminder(env, channelInteraction('duplicate'), 'owner', null, true, 5, { channel: '222' }), /already have/);
  assert.match(await controlReminder(env, 'stranger', 'stop', 'selected'), /no longer available/);
  assert.match(await controlReminder(env, 'owner', 'again', 'current', channelInteraction('button')), /in <#111>/);
  assert.equal((await DB.prepare("SELECT destination FROM reminders WHERE id='current'").first()).destination, 'channel');
  assert.match(await controlReminder(env, 'owner', 'stop', 'selected'), /cancelled/);
  const list = await listReminders(env, 'owner');
  assert.match(list.content, /Where/);
  assert.match(list.content, /<#111>/);
});

test('channel selection rejects missing access, other servers, unsupported channels and DM contexts', async t => {
  const env = { DISCORD_BOT_TOKEN: 'test' };
  const denied = channelInteraction('denied');
  denied.member.permissions = '1024';
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Permission failures must not call Discord'));
  await assert.rejects(reminderDestination(env, denied, 'owner', { where: 'channel' }), /You need/);
  const botDenied = channelInteraction('bot-denied');
  botDenied.data.resolved.channels['222'].app_permissions = '1024';
  await assert.rejects(reminderDestination(env, botDenied, 'owner', { channel: '222' }), /bot needs/);
  await assert.rejects(reminderDestination(env, {}, 'owner', { where: 'channel' }), /from that server/);
  await assert.rejects(reminderDestination(env, channelInteraction('conflict'), 'owner', { where: 'dm', channel: '222' }), /either DMs or a channel/);
  globalThis.fetch = async () => Response.json({ guild_id: 'another-server', type: 0 });
  await assert.rejects(reminderDestination(env, channelInteraction('cross-server'), 'owner', { channel: '222' }), /in this server/);
  globalThis.fetch = async () => Response.json({ guild_id: '555', type: 15 });
  await assert.rejects(reminderDestination(env, channelInteraction('forum'), 'owner', { where: 'channel' }), /text or announcement/);
});

test('DM and channel reminders can coexist and blocked channel sends become failed', async t => {
  const DB = database(); await seed(DB, schedule);
  const env = { DB, DISCORD_BOT_TOKEN: 'test' };
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (init.method === 'GET') return Response.json({ guild_id: '555', type: 0 });
    return Response.json({ id: 'dm' });
  });
  await createReminder(env, { id: 'dm-reminder' }, 'owner', null, false, 5);
  await createReminder(env, channelInteraction('channel-reminder'), 'owner', null, false, 5, { where: 'channel' });
  globalThis.fetch = async (url, init) => url.includes('/channels/111/')
    ? Response.json({ code: 50013 }, { status: 403 }) : Response.json({ id: 'sent' });
  await deliverReminders(env, now + 60000);
  assert.equal((await DB.prepare("SELECT status FROM reminders WHERE id='channel-reminder'").first()).status, 'failed');
  assert.equal((await DB.prepare("SELECT status FROM reminders WHERE id='dm-reminder'").first()).status, 'delivered');
});

test('channel command confirmation stays private and reports its chosen destination', async t => {
  const DB = database(); await seed(DB, schedule);
  const updates = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (init.method === 'GET') return Response.json({ guild_id: '555', type: 0 });
    updates.push(JSON.parse(init.body)); return Response.json({ id: 'response' });
  });
  const interaction = channelInteraction('command');
  interaction.type = 2;
  interaction.application_id = 'app';
  interaction.token = 'test';
  interaction.data.name = 'storm';
  interaction.data.options = [{ name: 'remind', options: [{ name: 'where', value: 'channel' }, { name: 'channel', value: '222' }] }];
  await processInteraction({ DB, DISCORD_BOT_TOKEN: 'test' }, interaction);
  assert.equal(updates.length, 1);
  assert.match(updates[0].content, /in <#222>/);
  assert.deepEqual(updates[0].allowed_mentions, { parse: [] });
});
