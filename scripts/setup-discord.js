import { spawnSync } from 'node:child_process';
import { configure } from './configure.js';
import { commands } from '../src/commands.js';
import { setupEmojis } from './setup-emojis.js';

const config = configure();
const { DISCORD_APPLICATION_ID: app, DISCORD_PUBLIC_KEY: publicKey, DISCORD_BOT_TOKEN: token, DISCORD_GUILD_ID: guild } = config;
if (!/^\d+$/.test(app ?? '') || !/^[a-f0-9]{64}$/i.test(publicKey ?? '') || !token) {
  console.error('Fill DISCORD_APPLICATION_ID, DISCORD_PUBLIC_KEY and DISCORD_BOT_TOKEN in .env. Keep that file private.'); process.exit(1);
}
if (guild && !/^\d+$/.test(guild)) throw new Error('DISCORD_GUILD_ID must contain the numeric server ID.');
await setupEmojis(config);
if (!process.argv.includes('--commands-only')) {
  const response = await fetch('https://discord.com/api/v10/oauth2/applications/@me', { headers: { Authorization: `Bot ${token}` } });
  if (!response.ok) throw new Error(`Could not identify the app owner (${response.status}).`);
  const application = await response.json();
  const owner = config.DISCORD_OWNER_ID || application.team?.owner_user_id || application.owner?.id;
  if (!/^\d+$/.test(owner ?? '')) throw new Error('Set DISCORD_OWNER_ID in .env for schedule outage alerts.');
  const secrets = JSON.stringify({ DISCORD_BOT_TOKEN: token, DISCORD_OWNER_ID: owner });
  const upload = spawnSync('wrangler', ['secret', 'bulk'], { input: secrets, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  if (upload.status !== 0) { console.error('Secret upload failed. Run wrangler secret put DISCORD_BOT_TOKEN interactively.'); process.exit(1); }
  console.log('Bot token stored as a Worker secret.');
}
// Enable both installation types before registering commands that support them.
const installation = await fetch('https://discord.com/api/v10/applications/@me', {
  method: 'PATCH',
  headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ integration_types_config: {
    '0': { oauth2_install_params: { scopes: ['bot', 'applications.commands'], permissions: '51200' } },
    '1': { oauth2_install_params: { scopes: ['applications.commands'], permissions: '0' } },
  } }),
});
if (!installation.ok) throw new Error(`Enabling server and account installation failed (${installation.status}).`);
console.log('Enabled server and account installation.');
const scopes = [`applications/${app}/commands`];
if (guild) scopes.push(`applications/${app}/guilds/${guild}/commands`);
for (const scope of scopes) {
  for (const command of commands) {
    const payload = { ...command };
    if (scope.includes('/guilds/')) { delete payload.contexts; delete payload.integration_types; }
    const response = await fetch(`https://discord.com/api/v10/${scope}`, { method: 'POST', headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!response.ok) { console.error(`Registering /${command.name} failed (${response.status}).`); process.exit(1); }
    console.log(`Registered /${command.name}${scope.includes('/guilds/') ? ' for the test server' : ' globally, including bot DMs'}.`);
  }
}
console.log(`Install: https://discord.com/oauth2/authorize?client_id=${app}&scope=bot%20applications.commands&permissions=51200&integration_type=0`);
console.log(`Personal install: https://discord.com/oauth2/authorize?client_id=${app}&scope=applications.commands&integration_type=1`);
