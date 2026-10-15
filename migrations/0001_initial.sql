CREATE TABLE schedule (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL,
  version TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  attempted_at INTEGER NOT NULL,
  last_error TEXT
);
CREATE TABLE preferences (
  user_id TEXT PRIMARY KEY,
  timezone TEXT NOT NULL
);
CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  dm_channel TEXT NOT NULL,
  location TEXT,
  repeating INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  lease_until INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX reminders_due ON reminders(status, next_at);
CREATE INDEX reminders_user ON reminders(user_id, status);
CREATE TABLE interactions (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
