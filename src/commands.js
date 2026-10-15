const timezone = { type: 3, name: 'timezone', description: 'Search all timezones by city, e.g. London or New York.', autocomplete: true };
const location = { type: 3, name: 'location', description: 'Search for a storm location.', autocomplete: true };
export const commands = [
  { name: 'storms', contexts: [0, 1, 2], integration_types: [0, 1], description: 'Show the current and next seven Soul Storms', options: [timezone, location] },
  { name: 'storm', contexts: [0, 1, 2], integration_types: [0, 1], description: 'Manage your Soul Storm preferences and DM reminders', options: [
    { type: 1, name: 'settings', description: 'Save your timezone', options: [{ ...timezone, required: true }] },
    { type: 1, name: 'remind', description: 'Get a DM when the next storm starts', options: [
      { ...location, description: 'A specific region. Leave empty for the next storm anywhere.' },
      { type: 5, name: 'repeat', description: 'Keep reminding you each time. Defaults to false' },
      { type: 4, name: 'before', description: 'Minutes before the start, from 0 to 30. Defaults to 0.', min_value: 0, max_value: 30 },
    ] },
    { type: 1, name: 'reminders', description: 'Privately view and cancel your DM reminders' },
  ] },
];
