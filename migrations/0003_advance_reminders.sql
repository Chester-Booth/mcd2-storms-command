ALTER TABLE reminders ADD COLUMN before_minutes INTEGER NOT NULL DEFAULT 0
  CHECK (before_minutes BETWEEN 0 AND 30);
