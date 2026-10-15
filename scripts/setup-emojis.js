import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnvironment } from './configure.js';
import { discord } from '../src/discord.js';

// Keep existing emoji IDs stable so older bot messages continue to display them.
export async function setupEmojis(env) {
  const path = `/applications/${env.DISCORD_APPLICATION_ID}/emojis`;
  const { items } = await discord(env, path, undefined, 'GET');
  for (const file of readdirSync(new URL('../assets/icons/', import.meta.url)).filter(name => name.endsWith('.png'))) {
    const name = file.slice(0, -4).replaceAll('-', '_');
    if (items.some(emoji => emoji.name === name)) continue;
    const image = readFileSync(new URL(`../assets/icons/${file}`, import.meta.url));
    await discord(env, path, { name, image: `data:image/png;base64,${image.toString('base64')}` });
    console.log(`Uploaded :${name}:`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await setupEmojis(readEnvironment());
}
