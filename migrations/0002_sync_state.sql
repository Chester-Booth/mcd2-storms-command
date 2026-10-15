CREATE TABLE sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  next_check_at INTEGER NOT NULL,
  outage_alerted INTEGER NOT NULL DEFAULT 0
);
