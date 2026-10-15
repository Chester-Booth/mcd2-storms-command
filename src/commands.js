const timezone = { type: 3, name: 'timezone', description: 'Search all timezones by city, e.g. London or New York.', autocomplete: true };
export const commands = [
  { name: 'storms', contexts: [0, 1], integration_types: [0], description: 'Show the current and next seven Soul Storms', options: [timezone] },
  { name: 'storm', contexts: [0, 1], integration_types: [0], description: 'Manage your Soul Storm preferences and DM reminders', options: [
    { type: 1, name: 'settings', description: 'Save your timezone', options: [{ ...timezone, required: true }] },
    { type: 1, name: 'remind', description: 'Get a DM when the next storm starts', options: [
      { type: 3, name: 'location', description: 'A specific region. Leave empty for the next storm anywhere.', autocomplete: true },
      { type: 5, name: 'repeat', description: 'Keep reminding you each time. Defaults to once.' },
    ] },
    { type: 1, name: 'reminders', description: 'Privately view and cancel your DM reminders' },
  ] },
];
