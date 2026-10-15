import { discord } from './discord.js';

export const SOURCE = 'https://www.dungeons.tools/2/soul-storm';

// Normalise source seconds to milliseconds and reject changes we cannot safely interpret.
export function validateSchedule(value) {
  if (!value || typeof value !== 'object') throw new Error('Missing storm schedule');
  const epoch = Date.parse(value.epochUtc);
  const { durationSeconds: duration, cadenceSeconds: cadence, areas } = value;
  if (!Number.isFinite(epoch) || !Number.isInteger(duration) || !Number.isInteger(cadence)
      || cadence < 60 || cadence > 86400 || duration < 1 || duration > cadence
      || !Array.isArray(areas) || areas.length < 1 || areas.length > 25) {
    throw new Error('Unrecognised storm schedule');
  }
  const cleaned = areas.map(area => {
    if (typeof area.name !== 'string' || !area.name.trim() || area.name.length > 80
        || typeof area.href !== 'string' || !/^\/2\/locations\/[a-z0-9-]+$/.test(area.href)) {
      throw new Error('Unrecognised storm region');
    }
    return { name: area.name, id: area.href.split('/').at(-1) };
  });
  if (new Set(cleaned.map(x => x.id)).size !== cleaned.length) throw new Error('Duplicate storm regions');
  return { epoch, duration: duration * 1000, cadence: cadence * 1000, areas: cleaned };
}

// Next.js streams the page props as JSON strings. Read them as data, never execute page scripts.
export function parseSchedule(html) {
  const streams = [];
  for (const match of html.matchAll(/self\.__next_f\.push\((\[[\s\S]*?\])\)<\/script>/g)) {
    try {
      const chunk = JSON.parse(match[1]);
      if (typeof chunk[1] === 'string') streams.push(chunk[1]);
    } catch { /* Ignore non-data scripts. */ }
  }
  const data = streams.join('');
  const start = data.indexOf('"storm":');
  if (start < 0) throw new Error('Storm data missing from dungeons.tools');
  const offset = data.indexOf('{', start);
  let depth = 0, quoted = false, escaped = false;
  for (let i = offset; i < data.length; i++) {
    const char = data[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return validateSchedule(JSON.parse(data.slice(offset, i + 1)));
  }
  throw new Error('Incomplete storm data');
}

export function stormAt(schedule, index) {
  const area = schedule.areas[((index % schedule.areas.length) + schedule.areas.length) % schedule.areas.length];
  const start = schedule.epoch + index * schedule.cadence;
  return { area, index, start, end: start + schedule.duration };
}

export function snapshot(schedule, now) {
  const index = Math.floor((now - schedule.epoch) / schedule.cadence);
  const latest = stormAt(schedule, index);
  return {
    current: now >= schedule.epoch && now < latest.end ? latest : null,
    upcoming: Array.from({ length: 7 }, (_, i) => stormAt(schedule, Math.max(0, index + 1) + i)),
  };
}

// Return the first matching start strictly after this instant, excluding an already active storm.
export function nextStorm(schedule, after, location = null) {
  if (location && !schedule.areas.some(area => area.id === location)) return null;
  let index = Math.max(0, Math.floor((after - schedule.epoch) / schedule.cadence) + 1);
  for (let i = 0; i < schedule.areas.length; i++, index++) {
    const storm = stormAt(schedule, index);
    if (!location || storm.area.id === location) return storm;
  }
  return null;
}

export async function readSchedule(env) {
  const row = await env.DB.prepare('SELECT * FROM schedule WHERE id = 1').first();
  if (!row) throw new Error('The storm schedule is unavailable. I will check for it hourly until it returns.');
  return { ...row, schedule: JSON.parse(row.data) };
}

// Skip a lead-time check already covered by the last attempt, including delayed cron runs.
export function nextScheduleCheck(schedule, after) {
  return nextStorm(schedule, after + 60000).start - 60000;
}

function cachedSchedule(row) {
  try {
    const schedule = JSON.parse(row.data);
    if (Number.isFinite(schedule.epoch) && Number.isFinite(schedule.cadence) && schedule.cadence >= 60000
        && Number.isFinite(schedule.duration) && schedule.duration > 0 && schedule.areas?.length) return schedule;
  } catch { /* No usable cached rotation. Retry hourly. */ }
  return null;
}

// Return whether reminders can use a cached schedule, even if the source refresh fails.
export async function syncSchedule(env, now = Date.now(), force = false) {
  const old = await env.DB.prepare('SELECT * FROM schedule WHERE id = 1').first();
  const cached = cachedSchedule(old);
  const state = await env.DB.prepare('SELECT * FROM sync_state WHERE id = 1').first();
  const due = state?.next_check_at ?? (cached ? nextScheduleCheck(cached, old.attempted_at) : 0);
  if (!force && now < due) return Boolean(cached);
  await env.DB.prepare('INSERT OR IGNORE INTO sync_state(id,next_check_at) VALUES(1,?)').bind(due).run();
  const nextCheck = cached ? nextScheduleCheck(cached, now) : now + 3600000;
  // Advance the due time atomically so overlapping cron runs do not fetch the source twice.
  const claimed = await env.DB.prepare('UPDATE sync_state SET next_check_at=? WHERE id=1 AND (next_check_at<=? OR ?=1) RETURNING id')
    .bind(nextCheck, now, force ? 1 : 0).first();
  if (!claimed) return Boolean(cached);
  try {
    const response = await fetch(SOURCE, {
      headers: { 'User-Agent': 'SoulStormsDiscord/0.1 (+https://github.com/Chester-Booth/mcd2-storms-command)' },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Schedule source returned ${response.status}`);
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 2_000_000) { await reader.cancel(); throw new Error('Schedule page exceeds size limit'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let position = 0;
    for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.length; }
    const schedule = parseSchedule(new TextDecoder().decode(bytes));
    const data = JSON.stringify(schedule);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
    const version = Array.from(new Uint8Array(hash), x => x.toString(16).padStart(2, '0')).join('').slice(0, 16);
    const statements = [];
    if (old && old.version !== version) {
      const { results } = await env.DB.prepare("SELECT id, location FROM reminders WHERE status IN ('active', 'sending')").all();
      for (const reminder of results) {
        const next = nextStorm(schedule, now, reminder.location);
        statements.push(env.DB.prepare('UPDATE reminders SET next_at = ?, status = ?, lease_until = 0, last_error = ? WHERE id = ?')
          .bind(next?.start ?? 0, next ? 'active' : 'failed', next ? null : 'This region is no longer in the storm rotation.', reminder.id));
      }
      console.log(JSON.stringify({ event: 'schedule_changed', previous: old.version, version }));
    }
    statements.push(env.DB.prepare(`INSERT INTO schedule (id, data, version, checked_at, attempted_at, last_error)
      VALUES (1, ?, ?, ?, ?, NULL) ON CONFLICT(id) DO UPDATE SET data=excluded.data, version=excluded.version,
      checked_at=excluded.checked_at, attempted_at=excluded.attempted_at, last_error=NULL`).bind(data, version, now, now));
    statements.push(env.DB.prepare('UPDATE sync_state SET next_check_at=?, outage_alerted=0 WHERE id=1').bind(nextScheduleCheck(schedule, now)));
    // Commit the new rotation and rescheduled reminders together. A successful sync rearms alerts.
    await env.DB.batch(statements);
    return true;
  } catch (error) {
    console.error(JSON.stringify({ event: 'schedule_sync_failed', error: error.message }));
    if (old) await env.DB.prepare('UPDATE schedule SET attempted_at = ?, last_error = ? WHERE id = 1').bind(now, error.message).run();
    await alertScheduleOutage(env, Boolean(cached));
    return Boolean(cached);
  }
}


// Persist alert suppression across Worker restarts; a later successful sync clears it.
async function alertScheduleOutage(env, hasCachedSchedule) {
  if (!env.DISCORD_OWNER_ID || !env.DISCORD_BOT_TOKEN) return;
  const claimed = await env.DB.prepare('UPDATE sync_state SET outage_alerted=1 WHERE id=1 AND outage_alerted=0 RETURNING id').first();
  if (!claimed) return;
  try {
    const channel = await discord(env, '/users/@me/channels', { recipient_id: env.DISCORD_OWNER_ID });
    await discord(env, `/channels/${channel.id}/messages`, {
      content: "I couldn't read a valid Soul Storm schedule from dungeons.tools. " + (hasCachedSchedule
        ? "I'm keeping the last known rotation and will check again before the next predicted storm."
        : "Storm tracking is unavailable. I'll check again in an hour.") + " I won't repeat this alert until a sync succeeds and another outage occurs.",
      allowed_mentions: { parse: [] },
    });
  } catch (error) {
    await env.DB.prepare('UPDATE sync_state SET outage_alerted=0 WHERE id=1').run();
    console.error(JSON.stringify({ event: 'schedule_alert_failed', error: error.message }));
  }
}
