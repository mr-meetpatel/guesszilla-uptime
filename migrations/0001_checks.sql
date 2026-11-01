CREATE TABLE IF NOT EXISTS checks (
  slot INTEGER PRIMARY KEY,
  checked_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('operational', 'degraded', 'unavailable')),
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS checks_status_slot ON checks(status, slot DESC);
