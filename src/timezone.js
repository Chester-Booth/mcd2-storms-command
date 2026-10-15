export function timezone(value = 'Europe/London') {
  const aliases = { uk: 'Europe/London', gmt: 'Etc/GMT', utc: 'UTC' };
  const candidate = aliases[value.toLowerCase()] ?? value;
  try { return new Intl.DateTimeFormat('en-GB', { timeZone: candidate }).resolvedOptions().timeZone; }
  catch { throw new Error('Unknown timezone. Choose a city such as Europe/London or America/New_York.'); }
}

const common = [
  'Europe/London', 'UTC', 'Europe/Paris', 'Europe/Berlin', 'Europe/Helsinki',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Toronto', 'America/Sao_Paulo', 'Africa/Johannesburg', 'Africa/Cairo',
  'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Hong_Kong', 'Asia/Tokyo',
  'Australia/Perth', 'Australia/Sydney', 'Pacific/Auckland',
];

const allZones = [...new Set([...common, ...Intl.supportedValuesOf('timeZone')])];

export function timezoneChoices(query = '', preferred = 'Europe/London') {
  const search = query.trim().replaceAll(' ', '_').toLowerCase();
  if (search === 'uk') return [{ name: 'London · UK', value: 'Europe/London' }];
  const zones = allZones;
  const candidates = search ? zones.filter(zone => zone.toLowerCase().includes(search)) : [...new Set([preferred, ...common])];
  if (search) candidates.sort((a, b) => Number(b.split('/').at(-1).toLowerCase().startsWith(search)) - Number(a.split('/').at(-1).toLowerCase().startsWith(search)));
  return candidates.slice(0, 25).map(zone => ({
    name: zone === 'UTC' ? 'UTC' : `${zone.split('/').at(-1).replaceAll('_', ' ')} · ${zone.split('/')[0]}`,
    value: zone,
  }));
}
