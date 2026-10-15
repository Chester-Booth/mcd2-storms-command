import { deflateSync } from 'node:zlib';
import art from './generated/art.json' with { type: 'json' };
import { snapshot } from './schedule.js';

const decode = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
// Decode immutable artwork once per isolate. Each response draws into its own background copy.
const background = decode(art.background);
const palette = decode(art.palette);
const blend = Object.fromEntries(Object.entries(art.blend).map(([colour, ramp]) => [colour, decode(ramp)]));
const sprites = Object.fromEntries(Object.entries(art.sprites).map(([name, sprite]) => [name, { ...sprite, data: decode(sprite.pixels) }]));
const fonts = Object.fromEntries(Object.entries(art.fonts).map(([name, glyphs]) => [name,
  Object.fromEntries(Object.entries(glyphs).map(([char, glyph]) => [char, { ...glyph, data: decode(glyph.pixels) }]))]));
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});

// PNG chunks contain a byte length, four-letter type, payload and CRC-32 checksum.
function chunk(type, data) {
  const output = new Uint8Array(data.length + 12);
  const view = new DataView(output.buffer);
  view.setUint32(0, data.length);
  output.set(new TextEncoder().encode(type), 4);
  output.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < output.length - 4; i++) crc = crcTable[(crc ^ output[i]) & 255] ^ (crc >>> 8);
  view.setUint32(output.length - 4, (crc ^ 0xffffffff) >>> 0);
  return output;
}

// Indexed pixels and pre-rasterised fonts avoid a browser or WASM renderer on the free tier.
export async function renderImage(schedule, now, zone) {
  const pixels = background.slice();
  function rect(x, y, w, h, colour) {
    for (let row = y; row < Math.min(y + h, art.height); row++) pixels.fill(colour, row * art.width + x, row * art.width + x + w);
  }
  function blit(sprite, x, y, colour = null) {
    if (!sprite) return;
    for (let row = 0; row < sprite.h; row++) {
      if (row + y >= art.height) break;
      for (let col = 0; col < sprite.w; col++) {
        const value = sprite.data[row * sprite.w + col];
        if (value && col + x < art.width) {
          const position = (row + y) * art.width + col + x;
          // Font masks contain four coverage levels; icon pixels are already palette indices.
          pixels[position] = colour === null ? value : blend[colour][pixels[position] * 4 + value];
        }
      }
    }
  }
  const measure = (text, font) => [...text].reduce((n, char) => n + (fonts[font][char] ?? fonts[font]['?']).w, 0);
  function text(value, x, y, font = 'body', colour = 8, maxWidth = 520) {
    let string = String(value);
    while (measure(string, font) > maxWidth && string.length > 1) string = string.slice(0, -2) + '.';
    for (const char of string) {
      const glyph = fonts[font][char] ?? fonts[font]['?'];
      blit(glyph, x, y - fonts[font].M.top, colour); x += glyph.w;
    }
  }
  const { current, upcoming } = snapshot(schedule, now);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const titleWidth = measure('SOUL STORMS', 'title');
  const titleHeight = fonts.title.M.bottom - fonts.title.M.top;
  text('SOUL STORMS', (art.width - titleWidth) >> 1, Math.round((14 + 54 - titleHeight) / 2), 'title');
  blit(sprites.soulstorm, 34, 96);
  const name = current ? current.area.name.toUpperCase() : 'NO ACTIVE STORM';
  const words = name.split(' ');
  const lines = [words.slice(0, -1).join(' '), words.at(-1)].filter(Boolean);
  lines.slice(0, 2).forEach((line, index) => text(line, 157, 89 + index * 36, 'hero', 8, 365));
  const until = current ? current.end : upcoming[0].start;
  const remaining = Math.max(0, Math.ceil((until - now) / 60000));
  const countdown = `${remaining} MIN`;
  text(countdown, 157, 174, 'time', 8);
  const baseline = font => fonts[font].M.baseline - fonts[font].M.top;
  text(current ? 'remaining' : 'until next storm', 157 + measure(countdown, 'time') + 12, 174 + baseline('time') - baseline('small'), 'small', 9, 225);
  rect(157, 213, 330, 8, 13);
  rect(159, 215, Math.max(1, Math.round(326 * Math.min(1, (until - now) / (current ? schedule.duration : schedule.cadence - schedule.duration)))), 4, 14);
  upcoming.forEach((storm, i) => {
    const y = 261 + i * 63;
    blit(sprites[storm.area.id] ?? sprites.soulstorm, 30, y + 8);
    text(storm.area.name, 82, y + 9, 'body', 8, 340);
    text(`until ${time.format(storm.end)}`, 82, y + 34, 'small', 10, 340);
    text(time.format(storm.start), 449, y + 19, 'time', 8, 80);
  });
  const updated = `${new Intl.DateTimeFormat('en-GB', { timeZone: zone, day: '2-digit', month: 'short' }).format(now)} · ${time.format(now)} · ${zone}`;
  text(updated, 22, 721, 'small', 10, 516);
  // PNG filter byte 0 precedes each row. Fast native deflate keeps rendering CPU use low.
  const scanlines = new Uint8Array((art.width + 1) * art.height);
  for (let y = 0; y < art.height; y++) scanlines.set(pixels.subarray(y * art.width, (y + 1) * art.width), y * (art.width + 1) + 1);
  const data = deflateSync(scanlines, { level: 1 });
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, art.width); view.setUint32(4, art.height); header[8] = 8; header[9] = 3;
  return new Blob([new Uint8Array([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('PLTE', palette), chunk('IDAT', data), chunk('IEND', new Uint8Array())], { type: 'image/png' });
}
