CREATE TABLE app_settings (
  settings_key TEXT PRIMARY KEY,
  values_json TEXT NOT NULL CHECK(json_valid(values_json)),
  revision INTEGER NOT NULL CHECK(revision > 0),
  updated_at TEXT NOT NULL,
  operation_id TEXT NOT NULL
);

CREATE TABLE app_settings_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  settings_key TEXT NOT NULL,
  values_json TEXT NOT NULL CHECK(json_valid(values_json)),
  revision INTEGER NOT NULL CHECK(revision > 0),
  changed_at TEXT NOT NULL,
  UNIQUE(settings_key, revision)
);

CREATE INDEX app_settings_history_key ON app_settings_history(settings_key, revision DESC);

CREATE TABLE product_margins (
  listing_id TEXT PRIMARY KEY,
  sku_snapshot TEXT NOT NULL,
  minimum_margin TEXT NOT NULL,
  target_margin TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  updated_at TEXT NOT NULL,
  operation_id TEXT NOT NULL
);

CREATE INDEX product_margins_updated ON product_margins(updated_at DESC, listing_id);
