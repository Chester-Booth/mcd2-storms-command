const timezone = { type: 3, name: 'timezone', description: 'Search all timezones by city, e.g. London or New York.', autocomplete: true };
const location = { type: 3, name: 'location', description: 'Search for a storm location.', autocomplete: true };
export const commands = [
  { name: 'storms', contexts: [0, 1, 2], integration_types: [0, 1], description: 'Show the current and next seven Soul Storms', options: [timezone, location] },
  { name: 'storm', contexts: [0, 1, 2], integration_types: [0, 1], description: 'Manage your Soul Storm preferences and reminders', options: [
    { type: 1, name: 'settings', description: 'Save your timezone', options: [{ ...timezone, required: true }] },
    { type: 1, name: 'remind', description: 'Get a reminder for the next storm', options: [
      { ...location, description: 'A specific region. Leave empty for the next storm anywhere.' },
      { type: 5, name: 'repeat', description: 'Keep reminding you each time. Defaults to false' },
      { type: 4, name: 'before', description: 'Minutes before the start, from 0 to 30. Defaults to 0.', min_value: 0, max_value: 30 },
      { type: 3, name: 'where', description: 'Where to send the reminder. Defaults to DMs', choices: [
        { name: 'DMs', value: 'dm' }, { name: 'Channel', value: 'channel' },
      ] },
      { type: 7, name: 'channel', description: 'Choose a channel, or leave empty to use the current channel', channel_types: [0, 5] },
    ] },
    { type: 1, name: 'reminders', description: 'Privately view and cancel your reminders' },
  ] },
];
