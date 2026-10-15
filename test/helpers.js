import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
export function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0002_sync_state.sql', import.meta.url), 'utf8'));
  const wrap = (sql, args = []) => ({
    bind: (...params) => wrap(sql, params),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => db.prepare(sql).run(...args),
  });
  return { prepare: sql => wrap(sql), batch: async statements => {
    db.exec('BEGIN');
    try { const result = []; for (const statement of statements) result.push(await statement.run()); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } };
}
export const sourceSchedule = {
  epochUtc: '2026-01-01T00:00:00Z', durationSeconds: 1200, cadenceSeconds: 2400,
  areas: ['howling-woods', 'singers-meadow', 'rainy-plains', 'humbler-huskland', 'lullaby-hills', 'frozen-highlands', 'honeycomb-fields']
    .map(id => ({ name: id.split('-').map(s => s[0].toUpperCase() + s.slice(1)).join(' '), href: `/2/locations/${id}` })),
};
export const page = value => `<script>self.__next_f.push(${JSON.stringify([1, `22:["$","div",null,{"storm":${JSON.stringify(value)}}]`])})</script>`;
export async function seed(DB, schedule, now = Date.now()) {
  await DB.prepare('INSERT INTO schedule(id,data,version,checked_at,attempted_at) VALUES(1,?,\'old\',?,?)').bind(JSON.stringify(schedule), now, now).run();
}
