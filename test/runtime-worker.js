// Local-only harness. This file is never the production entrypoint.
import worker from '../src/index.js';
import { renderImage } from '../src/image.js';
import { readSchedule, syncSchedule } from '../src/schedule.js';
export default {
  ...worker,
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/test/sync') {
      await syncSchedule(env, Date.now(), true);
      return Response.json({ synced: true });
    }
    if (url.pathname === '/test/image') {
      const { schedule } = await readSchedule(env);
      const now = Number(url.searchParams.get('now')) || Date.now();
      return new Response(await renderImage(schedule, now, url.searchParams.get('timezone') ?? 'Europe/London'));
    }
    return worker.fetch(request, env, ctx);
  },
};
