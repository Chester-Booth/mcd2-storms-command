import { discord, DiscordError } from './discord.js';

const canSend = value => {
  if (!/^\d+$/.test(value ?? '')) return false;
  const permissions = BigInt(value);
  return Boolean(permissions & 8n) || (permissions & 3072n) === 3072n;
};

// Check Discord's resolved permissions before storing a channel reminder. No test messages are sent.
export async function reminderDestination(env, interaction, userId, { where, channel } = {}) {
  if (where !== undefined && !['dm', 'channel'].includes(where)) throw new Error('Choose DMs or Channel for where');
  if (where === 'dm' && channel) throw new Error('Choose either DMs or a channel');
  if (where === 'channel' || channel) {
    const guild = interaction.guild_id;
    if (!guild) throw new Error('Create channel reminders from that server, or choose DMs');
    const current = interaction.channel_id ?? interaction.channel?.id;
    const id = channel ?? current;
    if (!/^\d+$/.test(id ?? '')) throw new Error('Choose a text channel for the reminder');
    const resolved = interaction.data?.resolved?.channels?.[id];
    const memberPermissions = id === current ? interaction.member?.permissions ?? resolved?.permissions : resolved?.permissions;
    const appPermissions = id === current ? interaction.app_permissions ?? resolved?.app_permissions : resolved?.app_permissions;
    if (!canSend(memberPermissions)) throw new Error('You need View Channel and Send Messages in the reminder channel');
    if (!canSend(appPermissions)) throw new Error('The bot needs View Channel and Send Messages in the reminder channel. Add it to the server if needed');
    let target;
    try { target = await discord(env, `/channels/${id}`, undefined, 'GET'); }
    catch { throw new Error('I could not access that channel. Add the bot to the server and check its channel permissions'); }
    if (target.guild_id !== guild) throw new Error('Choose a channel in this server');
    if (![0, 5].includes(target.type)) throw new Error('Choose a server text or announcement channel');
    return { kind: 'channel', id, guild };
  }
  try {
    const dm = await discord(env, '/users/@me/channels', { recipient_id: userId });
    return { kind: 'dm', id: dm.id, guild: null };
  } catch (error) {
    if (error instanceof DiscordError && [403, 400].includes(error.status)) {
      throw new Error('I could not open a DM with you. Check your Discord privacy settings, then try again. No reminder was activated');
    }
    throw new Error('I could not set up your DM reminder. Please try again shortly');
  }
}
