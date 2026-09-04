CREATE TABLE ready_mappings (
  ready_code TEXT PRIMARY KEY,
  ready_description TEXT NOT NULL,
  listing_id TEXT UNIQUE,
  sku TEXT UNIQUE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_at TEXT NOT NULL,
  operation_id TEXT NOT NULL
);
CREATE TABLE mapping_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ready_code TEXT NOT NULL,
  ready_description TEXT NOT NULL,
  listing_id TEXT,
  sku TEXT,
  revision INTEGER NOT NULL,
  changed_at TEXT NOT NULL,
  UNIQUE(ready_code, revision)
);
CREATE INDEX mapping_history_code ON mapping_history(ready_code, revision);
CREATE TABLE purchase_documents (
  document_key TEXT PRIMARY KEY,
  document_number TEXT NOT NULL,
  document_year INTEGER NOT NULL,
  document_date TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source_json TEXT NOT NULL CHECK(json_valid(source_json)),
  references_json TEXT NOT NULL CHECK(json_valid(references_json)),
  lines_json TEXT NOT NULL CHECK(json_valid(lines_json)),
  row_count INTEGER NOT NULL CHECK(row_count > 0),
  units INTEGER NOT NULL CHECK(units > 0),
  total_cents INTEGER NOT NULL CHECK(total_cents > 0),
  recorded_at TEXT NOT NULL,
  stock_status TEXT NOT NULL DEFAULT 'not_sent' CHECK(stock_status = 'not_sent'),
  UNIQUE(document_year, document_number)
);
CREATE INDEX purchase_documents_date ON purchase_documents(document_date DESC, document_key);
