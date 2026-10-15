import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deploymentConfig } from '../scripts/configure.js';

const template = JSON.parse(readFileSync(new URL('../wrangler.example.jsonc', import.meta.url), 'utf8'));
const env = {
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
  D1_DATABASE_NAME: 'my-storm-tracker',
  D1_DATABASE_ID: '00000000-0000-0000-0000-000000000001',
  DISCORD_APPLICATION_ID: '123456789012345678',
  DISCORD_PUBLIC_KEY: 'b'.repeat(64),
  DISCORD_BOT_TOKEN: 'private-bot-token',
  DISCORD_OWNER_ID: 'private-recipient',
};

test('deployment config uses local IDs without copying secrets or changing the template', () => {
  const config = deploymentConfig(template, env);
  assert.equal(config.account_id, env.CLOUDFLARE_ACCOUNT_ID);
  assert.equal(config.d1_databases[0].database_name, env.D1_DATABASE_NAME);
  assert.equal(config.d1_databases[0].database_id, env.D1_DATABASE_ID);
  assert.equal(config.vars.DISCORD_APPLICATION_ID, env.DISCORD_APPLICATION_ID);
  assert.equal(config.vars.DISCORD_PUBLIC_KEY, env.DISCORD_PUBLIC_KEY);
  assert.ok(!JSON.stringify(config).includes(env.DISCORD_BOT_TOKEN));
  assert.ok(!JSON.stringify(config).includes(env.DISCORD_OWNER_ID));
  assert.equal(template.account_id, 'YOUR_CLOUDFLARE_ACCOUNT_ID');
  assert.equal(template.d1_databases[0].database_name, 'YOUR_D1_DATABASE_NAME');
});

test('missing or invalid deployment IDs fail before generating a config', () => {
  assert.throws(() => deploymentConfig(template, { ...env, D1_DATABASE_ID: '' }), /valid D1_DATABASE_ID/);
  assert.throws(() => deploymentConfig(template, { ...env, D1_DATABASE_NAME: '' }), /valid D1_DATABASE_NAME/);
  assert.throws(() => deploymentConfig(template, { ...env, D1_DATABASE_NAME: 'invalid name' }), /valid D1_DATABASE_NAME/);
  assert.throws(() => deploymentConfig(template, { ...env, CLOUDFLARE_ACCOUNT_ID: 'placeholder' }), /valid CLOUDFLARE_ACCOUNT_ID/);
});
