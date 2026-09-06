CREATE TABLE cancellation_sync_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  activated_at TEXT NOT NULL,
  checkpoint_at TEXT NOT NULL,
  sync_started_from TEXT,
  sync_upper_bound TEXT,
  next_url TEXT,
  last_attempt_at TEXT,
  last_success_at TEXT,
  sync_status TEXT NOT NULL CHECK(sync_status IN ('idle','running','error')),
  last_error TEXT
);

CREATE TABLE client_cancellations (
  orderline_id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL,
  listing_id TEXT NOT NULL,
  sku_snapshot TEXT NOT NULL,
  product_snapshot TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  order_modified_at TEXT NOT NULL,
  orderline_created_at TEXT,
  return_reason INTEGER,
  processing_status TEXT NOT NULL CHECK(processing_status IN ('baseline','pending','assigned')),
  restoration_order_key TEXT,
  discovered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX client_cancellations_status_date
  ON client_cancellations(processing_status, order_modified_at DESC);
CREATE INDEX client_cancellations_restoration
  ON client_cancellations(restoration_order_key);

CREATE TABLE quantity_orders (
  order_key TEXT PRIMARY KEY,
  order_number TEXT NOT NULL UNIQUE,
  order_type TEXT NOT NULL CHECK(order_type = 'quantity_only'),
  title TEXT NOT NULL,
  document_date TEXT NOT NULL,
  line_count INTEGER NOT NULL CHECK(line_count > 0),
  units INTEGER NOT NULL CHECK(units > 0),
  created_at TEXT NOT NULL
);

CREATE TABLE quantity_order_lines (
  order_key TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  sku_snapshot TEXT NOT NULL,
  product_snapshot TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  source_orderline_ids_json TEXT NOT NULL CHECK(json_valid(source_orderline_ids_json)),
  PRIMARY KEY(order_key, listing_id),
  FOREIGN KEY(order_key) REFERENCES quantity_orders(order_key)
);

CREATE TABLE quantity_order_processing (
  order_key TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  sku_snapshot TEXT NOT NULL,
  incoming_quantity INTEGER NOT NULL CHECK(incoming_quantity > 0),
  bm_quantity_observed INTEGER NOT NULL CHECK(bm_quantity_observed >= 0),
  target_quantity INTEGER NOT NULL CHECK(target_quantity >= 0),
  quantity_status TEXT NOT NULL CHECK(quantity_status IN ('manual','applying','automatic')),
  processed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(order_key, listing_id),
  FOREIGN KEY(order_key, listing_id) REFERENCES quantity_order_lines(order_key, listing_id)
);

CREATE INDEX quantity_order_processing_status
  ON quantity_order_processing(quantity_status, processed_at);
