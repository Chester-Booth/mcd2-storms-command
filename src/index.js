import { verifyRequest } from './discord.js';
import { autocomplete, isPublic, runInteraction } from './interactions.js';
import { syncSchedule } from './schedule.js';
import { deliverReminders } from './reminders.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      const row = await env.DB.prepare('SELECT version, checked_at, last_error FROM schedule WHERE id=1').first();
      return Response.json({ ok: Boolean(row), discordConfigured: Boolean(env.DISCORD_PUBLIC_KEY && env.DISCORD_BOT_TOKEN), schedule: row ? { version: row.version, checkedAt: new Date(row.checked_at).toISOString(), syncDelayed: Boolean(row.last_error) } : null });
    }
    if (request.method === 'GET' && url.pathname === '/') return new Response('Soul Storm Tracker. Use /storms in Discord.');
    if (url.pathname !== '/interactions' || request.method !== 'POST') return new Response('Not found', { status: 404 });
    // Discord interactions are small. Bound memory even when the endpoint is called directly.
    const reader = request.body?.getReader();
    if (!reader) return new Response('Bad request', { status: 400 });
    let length = 0;
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 65536) { await reader.cancel(); return new Response('Payload too large', { status: 413 }); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const body = new TextDecoder().decode(bytes);
    if (!await verifyRequest(request, body, env.DISCORD_PUBLIC_KEY)) return new Response('Invalid signature', { status: 401 });
    let interaction;
    try { interaction = JSON.parse(body); } catch { return new Response('Invalid JSON', { status: 400 }); }
    if (interaction.type === 1) return Response.json({ type: 1 });
    if (interaction.application_id !== env.DISCORD_APPLICATION_ID) return new Response('Wrong application', { status: 401 });
    if (interaction.type === 4) return Response.json({ type: 8, data: { choices: await autocomplete(env, interaction) } });
    if (![2, 3].includes(interaction.type)) return new Response('Unsupported interaction', { status: 400 });
    // Acknowledge within Discord's three-second deadline, then finish the response in waitUntil.
    ctx.waitUntil(runInteraction(env, interaction));
    // Type 6 updates the clicked message; type 5 creates a new response. Flag 64 makes it private.
    if (interaction.type === 3 && isPublic(interaction)) return Response.json({ type: 6 });
    return Response.json({ type: 5, data: { flags: isPublic(interaction) ? 0 : 64 } });
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        // Cron still runs each minute for reminders; syncSchedule decides when a source fetch is due.
        const hasSchedule = await syncSchedule(env, controller.scheduledTime);
        if (hasSchedule) await deliverReminders(env, controller.scheduledTime);
        if (new Date(controller.scheduledTime).getUTCMinutes() === 0) {
          const cutoff = controller.scheduledTime - 7 * 86400000;
          await env.DB.batch([
            env.DB.prepare('DELETE FROM interactions WHERE created_at < ?').bind(cutoff),
            env.DB.prepare("DELETE FROM reminders WHERE status IN ('delivered','cancelled') AND created_at < ?").bind(cutoff),
          ]);
        }
      } catch (error) {
        console.error(JSON.stringify({ event: 'scheduled_task_failed', error: error.message }));
        throw error;
      }
    })());
  },
};
