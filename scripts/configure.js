import { readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function readEnvironment() {
  try { return parseEnv(readFileSync(new URL('../.env', import.meta.url), 'utf8')); }
  catch { throw new Error('Copy .env.example to .env and fill in your deployment details.'); }
}

// Only these non-secret values belong in Wrangler config. Tokens are uploaded separately by setup.
export function deploymentConfig(template, env) {
  const patterns = {
    CLOUDFLARE_ACCOUNT_ID: /^[a-f0-9]{32}$/i,
    D1_DATABASE_NAME: /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/,
    D1_DATABASE_ID: /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i,
    DISCORD_APPLICATION_ID: /^\d{17,20}$/,
    DISCORD_PUBLIC_KEY: /^[a-f0-9]{64}$/i,
  };
  for (const [name, pattern] of Object.entries(patterns)) {
    if (!pattern.test(env[name] ?? '')) throw new Error(`Set a valid ${name} in .env.`);
  }
  const config = structuredClone(template);
  config.account_id = env.CLOUDFLARE_ACCOUNT_ID;
  config.d1_databases[0].database_name = env.D1_DATABASE_NAME;
  config.d1_databases[0].database_id = env.D1_DATABASE_ID;
  config.vars = { ...config.vars, DISCORD_APPLICATION_ID: env.DISCORD_APPLICATION_ID, DISCORD_PUBLIC_KEY: env.DISCORD_PUBLIC_KEY };
  return config;
}

// Generate the default config in the project root so direct Wrangler commands also use it.
export function configure() {
  const env = readEnvironment();
  const template = JSON.parse(readFileSync(new URL('../wrangler.example.jsonc', import.meta.url), 'utf8'));
  const config = deploymentConfig(template, env);
  writeFileSync(new URL('../wrangler.jsonc', import.meta.url), JSON.stringify(config, null, 2) + '\n');
  return env;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  configure();
  console.log('Generated local wrangler.jsonc from .env.');
}
