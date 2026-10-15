import { discord, DiscordError, relative, clock } from './discord.js';
import { nextStorm, readSchedule, snapshot } from './schedule.js';

export async function createReminder(env, interaction, userId, location, repeating) {
  const now = Date.now();
  const { schedule } = await readSchedule(env);
  const next = nextStorm(schedule, now, location);
  if (!next) throw new Error('That location is no longer in the storm rotation. Choose a current region.');
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM reminders WHERE user_id = ? AND status IN ('active','sending')").bind(userId).first();
  if (count.count >= 10) throw new Error('You already have 10 active reminders. Cancel one with /storm reminders first.');
  const existing = await env.DB.prepare("SELECT id FROM reminders WHERE user_id = ? AND location IS ? AND repeating = ? AND status IN ('active','sending')")
    .bind(userId, location, repeating ? 1 : 0).first();
  if (existing) throw new Error('You already have this reminder. View it with /storm reminders.');
  let channel;
  try {
    // Open the DM channel without posting a test message. Delivery permissions may still fail later.
    channel = await discord(env, '/users/@me/channels', { recipient_id: userId });
  } catch (error) {
    if (error instanceof DiscordError && [403, 400].includes(error.status)) {
      throw new Error('I could not open a DM with you. Allow direct messages from this server, then try again. No reminder was activated.');
    }
    throw new Error('I could not set up your DM reminder. Please try again shortly.');
  }
  await env.DB.prepare(`INSERT INTO reminders (id, user_id, dm_channel, location, repeating, next_at, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`).bind(interaction.id, userId, channel.id, location, repeating ? 1 : 0, next.start, now).run();
  return `Confirmed, I'll remind you ${relative(next.start)} when the next storm starts${location ? ` in ${next.area.name}` : ''}.`;
}

export async function listReminders(env, userId) {
  const { results } = await env.DB.prepare("SELECT * FROM reminders WHERE user_id = ? AND status IN ('active','sending','failed') ORDER BY created_at DESC LIMIT 10").bind(userId).all();
  if (!results.length) return { content: 'You have no reminders. Use /storm remind to create one.', components: [] };
  const { schedule } = await readSchedule(env);
  const lines = results.map(r => {
    const label = r.location ? schedule.areas.find(x => x.id === r.location)?.name ?? r.location : 'Any storm';
    return `${label} · ${r.repeating ? 'Yes' : 'No'} · ${r.status === 'failed' ? `stopped: ${r.last_error}` : relative(r.next_at)}`;
  });
  return {
    content: '**Storm · Repeat · Next start**\n' + lines.join('\n'),
    components: [{ type: 1, components: [{ type: 3, custom_id: 'cancel-reminder', placeholder: 'Cancel a reminder', options: results.map(r => ({ label: `Cancel ${r.location ? schedule.areas.find(x => x.id === r.location)?.name ?? r.location : 'any storm'}${r.repeating ? ' (repeating)' : ''}`.slice(0, 100), value: r.id })) }] }],
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
    const event = snapshot(schedule, reminder.next_at).current;
    if (!event || (reminder.location && event.area.id !== reminder.location)) {
      await advance(env, reminder, schedule, now, 'The storm schedule changed before delivery.');
      continue;
    }
    if (now >= event.end) {
      await advance(env, reminder, schedule, now, 'The storm ended before this reminder could be delivered.');
      continue;
    }
    try {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${reminder.id}:${reminder.next_at}`));
      const nonce = Array.from(new Uint8Array(digest).slice(0, 12), n => n.toString(16).padStart(2, '0')).join('');
      await discord(env, `/channels/${reminder.dm_channel}/messages`, {
        content: `A Soul Storm has started in **${event.area.name}**.\nEnds ${clock(event.end)} · ${relative(event.end)}.`,
        allowed_mentions: { parse: [] }, nonce, enforce_nonce: true,
      });
      await advance(env, reminder, schedule, now);
    } catch (error) {
      if (error instanceof DiscordError && [400, 401, 403, 404].includes(error.status)) {
        await env.DB.prepare("UPDATE reminders SET status='failed', last_error='Discord could not deliver the DM.', lease_until=0 WHERE id=? AND status='sending'").bind(reminder.id).run();
      } else {
        await env.DB.prepare("UPDATE reminders SET lease_until=? WHERE id=? AND status='sending'").bind(now + Math.max(60000, (error.retryAfter ?? 0) * 1000), reminder.id).run();
      }
      console.error(JSON.stringify({ event: 'reminder_delivery_failed', status: error.status ?? 'network' }));
    }
  }
}

// Finish a one-off reminder or schedule the next occurrence, always releasing the delivery lease.
async function advance(env, reminder, schedule, now, reason = null) {
  const next = reminder.repeating ? nextStorm(schedule, now, reminder.location) : null;
  await env.DB.prepare('UPDATE reminders SET next_at=?, status=?, lease_until=0, last_error=? WHERE id=? AND status=\'sending\'')
    .bind(next?.start ?? reminder.next_at, next ? 'active' : reason ? 'failed' : 'delivered', reason, reminder.id).run();
}
