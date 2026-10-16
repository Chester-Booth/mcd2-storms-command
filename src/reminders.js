import { discord, DiscordError, relative, clock } from './discord.js';
import { nextReminder, readSchedule, snapshot } from './schedule.js';
import { applicationEmojis, emojiText } from './emojis.js';
import { reminderDestination } from './delivery.js';

export async function createReminder(env, interaction, userId, location, repeating, beforeMinutes = 0, delivery = {}) {
  if (!Number.isInteger(beforeMinutes) || beforeMinutes < 0 || beforeMinutes > 30) throw new Error('Choose between 0 and 30 minutes before the storm.');
  const now = Date.now();
  const { schedule } = await readSchedule(env);
  const next = nextReminder(schedule, now, location, beforeMinutes);
  if (!next) throw new Error('That location is no longer in the storm rotation. Choose a current region.');
  const destination = delivery.where === 'channel' || delivery.channel ? 'channel' : 'dm';
  await checkReminderLimit(env, userId, location, repeating, beforeMinutes, destination, delivery.channel ?? interaction.channel_id ?? interaction.channel?.id ?? null);
  const target = await reminderDestination(env, interaction, userId, delivery);
  // The legacy dm_channel column now stores either a DM or a server channel ID.
  await env.DB.prepare(`INSERT INTO reminders (id, user_id, dm_channel, location, repeating, next_at, status, created_at, before_minutes, destination, guild_id)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`).bind(interaction.id, userId, target.id, location, repeating ? 1 : 0, next.notifyAt, now, beforeMinutes, target.kind, target.guild).run();
  return reminderConfirmation(env, next, location, beforeMinutes, target.kind === 'channel' ? target.id : null);
}

async function reminderConfirmation(env, next, location, beforeMinutes, channel = null) {
  const emojis = location ? await applicationEmojis(env) : {};
  const timing = beforeMinutes ? `${beforeMinutes} ${beforeMinutes === 1 ? 'minute' : 'minutes'} before` : 'when';
  return `Confirmed, I'll remind you${channel ? ` in <#${channel}>` : ''} ${relative(next.notifyAt)} ${timing} the next storm starts${location ? ` in ${emojiText(emojis, location)}${next.area.name}` : ''}${beforeMinutes ? `\nStarts at ${clock(next.start)}` : ''}`;
}

async function checkReminderLimit(env, userId, location, repeating, beforeMinutes, destination, channel) {
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM reminders WHERE user_id = ? AND status IN ('active','sending')").bind(userId).first();
  if (count.count >= 10) throw new Error('You already have 10 active reminders. Cancel one with /storm reminders first.');
  const existing = await env.DB.prepare("SELECT id FROM reminders WHERE user_id = ? AND location IS ? AND repeating = ? AND before_minutes = ? AND destination = ? AND (destination = 'dm' OR dm_channel = ?) AND status IN ('active','sending')")
    .bind(userId, location, repeating ? 1 : 0, beforeMinutes, destination, channel).first();
  if (existing) throw new Error('You already have this reminder. View it with /storm reminders.');
}

// Buttons reference the stored reminder. Other channel members cannot change its owner's reminder.
export async function controlReminder(env, userId, action, id, interaction) {
  const reminder = await env.DB.prepare('SELECT * FROM reminders WHERE id=? AND user_id=?').bind(id, userId).first();
  if (!reminder) return 'This reminder is no longer available.';
  if (action === 'stop' && reminder.repeating) {
    const result = await env.DB.prepare("UPDATE reminders SET status='cancelled', lease_until=0 WHERE id=? AND user_id=? AND status IN ('active','sending','failed') RETURNING id")
      .bind(id, userId).first();
    return result ? 'Reminder cancelled.' : 'This reminder is no longer active.';
  }
  if (action !== 'again' || reminder.repeating || reminder.status !== 'delivered') return 'This reminder is no longer available or is already active.';
  const { schedule } = await readSchedule(env);
  const next = nextReminder(schedule, Date.now(), reminder.location, reminder.before_minutes);
  if (!next) throw new Error('That location is no longer in the storm rotation. Choose a current region.');
  if (reminder.destination === 'channel') {
    if (interaction?.guild_id !== reminder.guild_id) return 'Use the reminder button in its original server channel';
    await reminderDestination(env, interaction, userId, { where: 'channel', channel: reminder.dm_channel });
  }
  await checkReminderLimit(env, userId, reminder.location, false, reminder.before_minutes, reminder.destination, reminder.dm_channel);
  const result = await env.DB.prepare("UPDATE reminders SET status='active', next_at=?, created_at=?, last_error=NULL, lease_until=0 WHERE id=? AND user_id=? AND status='delivered' RETURNING id")
    .bind(next.notifyAt, Date.now(), id, userId).first();
  return result ? reminderConfirmation(env, next, reminder.location, reminder.before_minutes, reminder.destination === 'channel' ? reminder.dm_channel : null) : 'This reminder is already active.';
}

export async function listReminders(env, userId) {
  const { results } = await env.DB.prepare("SELECT * FROM reminders WHERE user_id = ? AND status IN ('active','sending','failed') ORDER BY created_at DESC LIMIT 10").bind(userId).all();
  if (!results.length) return { content: 'You have no reminders. Use /storm remind to create one.', components: [] };
  const { schedule } = await readSchedule(env);
  const emojis = await applicationEmojis(env);
  const lines = results.map(r => {
    const label = r.location ? schedule.areas.find(x => x.id === r.location)?.name ?? r.location : 'Any storm';
    return `${emojiText(emojis, r.location)}${label} · ${r.repeating ? 'Yes' : 'No'} · ${r.status === 'failed' ? `stopped: ${r.last_error?.replace(/\.$/, '')}` : `${relative(r.next_at)} · ${r.before_minutes ? `${r.before_minutes} min before` : 'At start'}`} · ${r.destination === 'channel' ? `<#${r.dm_channel}>` : 'DMs'}`;
  });
  return {
    content: '**Storm · Repeat · Notify · Where**\n' + lines.join('\n'),
    components: [{ type: 1, components: [{ type: 3, custom_id: 'cancel-reminder', placeholder: 'Cancel a reminder', options: results.map(r => ({ label: `Cancel ${r.location ? schedule.areas.find(x => x.id === r.location)?.name ?? r.location : 'any storm'}${r.repeating ? ' (repeating)' : ''}`.slice(0, 100), value: r.id, ...(emojis[r.location ?? 'soulstorm'] ? { emoji: emojis[r.location ?? 'soulstorm'] } : {}) })) }] }],
  };
}

// Claim each due row before sending. A stable Discord nonce limits duplicates after a retry.
export async function deliverReminders(env, now = Date.now()) {
  if (!env.DISCORD_BOT_TOKEN) return;
  const { schedule } = await readSchedule(env);
  const { results } = await env.DB.prepare(`SELECT * FROM reminders WHERE next_at <= ? AND
    (status = 'active' OR (status = 'sending' AND lease_until < ?)) ORDER BY next_at LIMIT 10`).bind(now, now).all();
  for (const reminder of results) {
    // A two-minute lease lets a later cron retry if this run stops before recording delivery.
    const claim = await env.DB.prepare(`UPDATE reminders SET status='sending', lease_until=? WHERE id=?
      AND (status='active' OR (status='sending' AND lease_until < ?)) RETURNING id`)
      .bind(now + 120000, reminder.id, now).first();
    if (!claim) continue;
    // Resolve the original scheduled event, not the time of this possibly delayed cron run.
    const event = snapshot(schedule, reminder.next_at + reminder.before_minutes * 60000).current;
    if (!event || (reminder.location && event.area.id !== reminder.location)) {
      await advance(env, reminder, schedule, now, 'The storm schedule changed before delivery.');
      continue;
    }
    if (now >= event.end) {
      await advance(env, reminder, schedule, now, 'The storm ended before this reminder could be delivered.');
      continue;
    }
    try {
      const emojis = await applicationEmojis(env);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${reminder.id}:${reminder.next_at}`));
      const nonce = Array.from(new Uint8Array(digest).slice(0, 12), n => n.toString(16).padStart(2, '0')).join('');
      await discord(env, `/channels/${reminder.dm_channel}/messages`, {
        content: `${reminder.destination === 'channel' ? `<@${reminder.user_id}> ` : ''}${emojiText(emojis, reminder.location)}A Soul Storm ${now < event.start ? `starts in **${event.area.name}** ${relative(event.start)}` : `has started in **${event.area.name}**`}\n${now < event.start ? `Starts ${clock(event.start)} · Ends ${clock(event.end)}` : `Ends ${clock(event.end)} · ${relative(event.end)}`}`,
        components: [{ type: 1, components: [{ type: 2, style: 2,
          label: reminder.repeating ? 'Stop reminders' : 'Remind me next time',
          custom_id: `reminder:${reminder.repeating ? 'stop' : 'again'}:${reminder.id}` }] }],
        allowed_mentions: { parse: [], ...(reminder.destination === 'channel' ? { users: [reminder.user_id] } : {}) }, nonce, enforce_nonce: true,
      });
      await advance(env, reminder, schedule, now);
    } catch (error) {
      if (error instanceof DiscordError && [400, 401, 403, 404].includes(error.status)) {
        await env.DB.prepare("UPDATE reminders SET status='failed', last_error='Discord could not deliver the reminder', lease_until=0 WHERE id=? AND status='sending'").bind(reminder.id).run();
      } else {
        await env.DB.prepare("UPDATE reminders SET lease_until=? WHERE id=? AND status='sending'").bind(now + Math.max(60000, (error.retryAfter ?? 0) * 1000), reminder.id).run();
      }
      console.error(JSON.stringify({ event: 'reminder_delivery_failed', status: error.status ?? 'network' }));
    }
  }
}

// Finish a one-off reminder or schedule the next occurrence, always releasing the delivery lease.
async function advance(env, reminder, schedule, now, reason = null) {
  const next = reminder.repeating ? nextReminder(schedule, now, reminder.location, reminder.before_minutes) : null;
  await env.DB.prepare('UPDATE reminders SET next_at=?, status=?, lease_until=0, last_error=? WHERE id=? AND status=\'sending\'')
    .bind(next?.notifyAt ?? reminder.next_at, next ? 'active' : reason ? 'failed' : 'delivered', reason, reminder.id).run();
}
