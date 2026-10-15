import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { configure } from './configure.js';
import { parseSchedule, SOURCE } from '../src/schedule.js';
configure();
const response = await fetch(SOURCE);
if (!response.ok) throw new Error(`Schedule source returned ${response.status}`);
const data = JSON.stringify(parseSchedule(await response.text()));
const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
const version = Buffer.from(digest).toString('hex').slice(0, 16);
const now = Date.now();
mkdirSync('tmp', { recursive: true });
// Bootstrap only. Normal updates run in the Worker and recalculate reminders together.
writeFileSync('tmp/seed.sql', `INSERT OR IGNORE INTO schedule(id,data,version,checked_at,attempted_at) VALUES(1,'${data.replaceAll("'", "''")}','${version}',${now},${now});`);
const result = spawnSync('wrangler', ['d1', 'execute', 'DB', process.argv.includes('--local') ? '--local' : '--remote', '--file', 'tmp/seed.sql'], { stdio: 'inherit' });
process.exitCode = result.status;
