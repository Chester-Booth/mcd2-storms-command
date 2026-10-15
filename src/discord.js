export const API = 'https://discord.com/api/v10';

export class DiscordError extends Error {
  constructor(status, code, retryAfter = 0) {
    super(`Discord request failed (${status}, code ${code ?? 'unknown'})`);
    this.status = status; this.code = code; this.retryAfter = retryAfter;
  }
}

// Bot-authenticated requests handle DMs; interaction responses use their own short-lived token.
export async function discord(env, path, body, method = 'POST') {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new DiscordError(response.status, data?.code, data?.retry_after ?? 0);
  return data;
}

// PATCH the deferred response or clicked message. Multipart uploads replace its attached image.
export async function editResponse(interaction, message, image = null, description = '') {
  const body = image ? new FormData() : JSON.stringify(message);
  if (image) {
    body.set('payload_json', JSON.stringify({ ...message, attachments: [{ id: 0, filename: 'storms.png', description }] }));
    body.set('files[0]', image, 'storms.png');
  }
  const response = await fetch(`${API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
    method: 'PATCH',
    headers: image ? {} : { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Discord response update failed (${response.status})`);
}

// Verify the original body, including whitespace, and reject signatures older than five minutes.
export async function verifyRequest(request, body, publicKey, now = Date.now()) {
  const signature = request.headers.get('X-Signature-Ed25519') ?? '';
  const timestamp = request.headers.get('X-Signature-Timestamp') ?? '';
  if (!/^[0-9a-f]{128}$/i.test(signature) || !/^\d+$/.test(timestamp)
      || Math.abs(now - Number(timestamp) * 1000) > 5 * 60000 || !/^[0-9a-f]{64}$/i.test(publicKey ?? '')) return false;
  const hex = value => Uint8Array.from(value.match(/../g), x => parseInt(x, 16));
  try {
    const key = await crypto.subtle.importKey('raw', hex(publicKey), 'Ed25519', false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, hex(signature), new TextEncoder().encode(timestamp + body));
  } catch { return false; }
}

export const relative = timestamp => `<t:${Math.floor(timestamp / 1000)}:R>`;
export const clock = timestamp => `<t:${Math.floor(timestamp / 1000)}:t>`;
export const privateMessage = content => ({ content: content.replace(/\.$/, ''), allowed_mentions: { parse: [] }, embeds: [], components: [] });
