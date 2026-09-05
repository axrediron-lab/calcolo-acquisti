CREATE TABLE exchange_rate_status (
  status_key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  reference_date TEXT,
  last_attempt_at TEXT NOT NULL,
  last_success_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('ok', 'error')),
  last_error TEXT
);
