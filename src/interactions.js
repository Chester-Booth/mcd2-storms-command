import { editResponse, privateMessage, clock, relative } from './discord.js';
import { snapshot, readSchedule } from './schedule.js';
import { timezone, timezoneChoices } from './timezone.js';
import { renderImage } from './image.js';
import { createReminder, listReminders, controlReminder } from './reminders.js';
import { applicationEmojis, emojiText } from './emojis.js';

// Server interactions nest the user under member; bot DMs provide user directly.
export const userId = interaction => interaction.member?.user?.id ?? interaction.user?.id;
const options = interaction => interaction.data?.options?.[0]?.options ?? interaction.data?.options ?? [];
const option = (interaction, name) => options(interaction).find(x => x.name === name)?.value;
export const isPublic = interaction => interaction.type === 3 ? interaction.data?.custom_id?.startsWith('refresh:') : interaction.data?.name === 'storms';

export async function autocomplete(env, interaction) {
  const focused = options(interaction).find(x => x.focused);
  if (focused?.name === 'timezone') return timezoneChoices(String(focused.value ?? ''));
  if (focused?.name === 'location') {
    try {
      const { schedule } = await readSchedule(env);
      const query = String(focused.value ?? '').toLowerCase();
      return schedule.areas.filter(x => x.name.toLowerCase().includes(query)).slice(0, 25).map(x => ({ name: x.name, value: x.id }));
    } catch { return []; }
  }
  return [];
}

export async function stormResponse(env, interaction, zone, location = null) {
  const now = Date.now();
  const stored = await readSchedule(env);
  const { current, upcoming } = snapshot(stored.schedule, now, location);
  const emojis = await applicationEmojis(env);
  const status = `${emojiText(emojis)}${current ? 'Storm active' : `No active storm${location ? ` in ${upcoming[0].area.name}` : ''}`}\n`;
  const timing = current ? `${emojiText(emojis, current.area.id)}${current.area.name} ends ${clock(current.end)} · ${relative(current.end)}\n` : '';
  const next = upcoming[0];
  const stale = now - stored.checked_at > 60 * 60000 ? '\nSchedule sync is delayed. Using the last known rotation' : '';
  const image = await renderImage(stored.schedule, now, zone, location);
  const description = imageDescription(stored.schedule, now, zone, location);
  await editResponse(interaction, {
    // Components v2 lets the image appear above the live Discord timestamps.
    flags: 32768,
    components: [
      { type: 12, items: [{ media: { url: 'attachment://storms.png' }, description }] },
      { type: 10, content: `${status}${timing}${emojiText(emojis, next.area.id)}${next.area.name} starts at ${clock(next.start)} · ${relative(next.start)}${stale}` },
      { type: 1, components: [{ type: 2, style: 2, label: 'Refresh', custom_id: `refresh:${zone}${location ? `:${location}` : ''}` }] },
    ],
    allowed_mentions: { parse: [] },
  }, image, description);
}

export async function processInteraction(env, interaction) {
  const id = userId(interaction);
  if (!id) throw new Error('Discord did not identify the user.');
  if (interaction.type === 3) {
    const customId = interaction.data.custom_id;
    // The button stores the message's timezone so another user's Refresh keeps its formatting.
    if (customId.startsWith('refresh:')) {
      const [, zone, location] = customId.split(':');
      return stormResponse(env, interaction, timezone(zone), location || null);
    }
    if (customId.startsWith('reminder:')) {
      const [, action, reminderId] = customId.split(':');
      return editResponse(interaction, privateMessage(await controlReminder(env, id, action, reminderId)));
    }
    if (customId === 'cancel-reminder') {
      const reminderId = interaction.data.values?.[0];
      // Check ownership in SQL even though the cancellation menu is private.
      const result = await env.DB.prepare("UPDATE reminders SET status='cancelled', lease_until=0 WHERE id=? AND user_id=? AND status IN ('active','sending','failed') RETURNING id")
        .bind(reminderId ?? '', id).first();
      return editResponse(interaction, privateMessage(result ? 'Reminder cancelled.' : 'This reminder is no longer active.'));
    }
    throw new Error('Unknown button. Run the command again.');
  }
  if (interaction.data.name === 'storms') {
    const saved = await env.DB.prepare('SELECT timezone FROM preferences WHERE user_id=?').bind(id).first();
    return stormResponse(env, interaction, timezone(option(interaction, 'timezone') ?? saved?.timezone), option(interaction, 'location') ?? null);
  }
  if (interaction.data.name !== 'storm') throw new Error('Unknown command.');
  switch (interaction.data.options?.[0]?.name) {
    case 'settings': {
      const zone = timezone(String(option(interaction, 'timezone')));
      await env.DB.prepare('INSERT INTO preferences(user_id,timezone) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET timezone=excluded.timezone').bind(id, zone).run();
      return editResponse(interaction, privateMessage(`Your timezone is now ${zone}.`));
    }
    case 'remind': {
      if (!env.DISCORD_BOT_TOKEN) throw new Error('The bot token has not been configured yet.');
      const location = option(interaction, 'location') ?? null;
      const repeating = option(interaction, 'repeat') === true;
      return editResponse(interaction, privateMessage(await createReminder(env, interaction, id, location, repeating, option(interaction, 'before') ?? 0)));
    }
    case 'reminders': {
      const message = await listReminders(env, id);
      return editResponse(interaction, { ...privateMessage(message.content), components: message.components });
    }
    default: throw new Error('Unknown command.');
  }
}

export async function runInteraction(env, interaction) {
  try {
    // Discord can retry delivery. An interaction ID must trigger side effects only once.
    const claimed = await env.DB.prepare('INSERT OR IGNORE INTO interactions(id,created_at) VALUES (?,?) RETURNING id').bind(interaction.id, Date.now()).first();
    if (!claimed) return;
    await processInteraction(env, interaction);
  } catch (error) {
    console.error(JSON.stringify({ event: 'interaction_failed', command: interaction.data?.name ?? 'component', error: error.message }));
    try {
      // Public commands contain no personal data; reminder and settings errors remain ephemeral.
      const content = error.message.startsWith('Discord response') ? 'Discord could not update the response. Please try again.' : error.message;
      await editResponse(interaction, interaction.type === 3 && isPublic(interaction)
        ? { components: [{ type: 10, content: content.replace(/\.$/, '') }], attachments: [], allowed_mentions: { parse: [] } }
        : privateMessage(content));
    } catch (updateError) {
      console.error(JSON.stringify({ event: 'error_response_failed', error: updateError.message }));
    }
  }
}

export function imageDescription(schedule, now, zone, location = null) {
  const { current, upcoming } = snapshot(schedule, now, location);
  const format = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const date = new Intl.DateTimeFormat('en-GB', { timeZone: zone, day: 'numeric', month: 'short', year: 'numeric' }).format(now);
  const active = current ? `Active: ${current.area.name}, ends ${format.format(current.end)}.` : 'No active storm.';
  const eventDate = new Intl.DateTimeFormat('en-GB', { timeZone: zone, day: 'numeric', month: 'short' });
  return `Soul Storms${location ? ` in ${upcoming[0].area.name}` : ''}, ${date} at ${format.format(now)}, ${zone}. ${active} Next seven storms: ${upcoming.map(storm => `${storm.area.name}, ${location ? `${eventDate.format(storm.start)} ` : ''}${format.format(storm.start)} to ${format.format(storm.end)}`).join('; ')}.`.slice(0, 1024);
}
