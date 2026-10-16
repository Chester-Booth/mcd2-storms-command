-- dm_channel is the existing destination channel ID, including server channels from now on.
ALTER TABLE reminders ADD COLUMN destination TEXT NOT NULL DEFAULT 'dm'
  CHECK (destination IN ('dm', 'channel'));
ALTER TABLE reminders ADD COLUMN guild_id TEXT;
