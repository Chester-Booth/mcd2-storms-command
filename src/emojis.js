import { discord } from './discord.js';

const cache = new Map();

// IDs belong to each Discord application. Cache them per Worker instance and keep text usable on failure.
export async function applicationEmojis(env) {
  const app = env.DISCORD_APPLICATION_ID;
  if (!app || !env.DISCORD_BOT_TOKEN) return {};
  const cached = cache.get(app);
  if (cached && cached.until > Date.now()) return cached.value;
  const entry = { until: Date.now() + 3600000 };
  entry.value = discord(env, `/applications/${app}/emojis`, undefined, 'GET')
    .then(data => Object.fromEntries(data.items.map(emoji => [emoji.name.replaceAll('_', '-'), { id: emoji.id, name: emoji.name }])))
    .catch(() => {
      entry.until = Date.now() + 60000;
      return {};
    });
  cache.set(app, entry);
  return entry.value;
}

export function emojiText(emojis, location) {
  const emoji = emojis[location ?? 'soulstorm'];
  return emoji ? `<:${emoji.name}:${emoji.id}> ` : '';
}
