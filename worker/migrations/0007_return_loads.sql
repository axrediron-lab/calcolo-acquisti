ALTER TABLE quantity_orders ADD COLUMN source_type TEXT NOT NULL DEFAULT 'client_cancellation';

CREATE TABLE return_loads (
  order_key TEXT PRIMARY KEY,
  load_number TEXT NOT NULL UNIQUE,
  load_date TEXT NOT NULL,
  daily_sequence INTEGER NOT NULL CHECK(daily_sequence > 0),
  content_hash TEXT NOT NULL UNIQUE,
  source_name TEXT NOT NULL,
  source_modified_at TEXT,
  source_sha256 TEXT NOT NULL,
  source_row_count INTEGER NOT NULL CHECK(source_row_count > 0),
  source_documents_json TEXT NOT NULL CHECK(json_valid(source_documents_json)),
  source_json TEXT NOT NULL CHECK(json_valid(source_json)),
  recorded_at TEXT NOT NULL,
  UNIQUE(load_date, daily_sequence),
  FOREIGN KEY(order_key) REFERENCES quantity_orders(order_key)
);

CREATE INDEX return_loads_date ON return_loads(load_date DESC, daily_sequence DESC);
