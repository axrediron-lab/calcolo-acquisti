CREATE TABLE product_costs (
  listing_id TEXT PRIMARY KEY,
  sku_snapshot TEXT NOT NULL,
  average_cost_cents INTEGER NOT NULL CHECK(average_cost_cents > 0),
  revision INTEGER NOT NULL CHECK(revision > 0),
  source_document_key TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE purchase_processing (
  document_key TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  sku_snapshot TEXT NOT NULL,
  incoming_quantity INTEGER NOT NULL CHECK(incoming_quantity > 0),
  incoming_total_cents INTEGER NOT NULL CHECK(incoming_total_cents > 0),
  previous_average_cost_cents INTEGER,
  previous_quantity INTEGER,
  new_average_cost_cents INTEGER NOT NULL CHECK(new_average_cost_cents > 0),
  bm_quantity_observed INTEGER NOT NULL CHECK(bm_quantity_observed >= 0),
  target_quantity INTEGER NOT NULL CHECK(target_quantity >= 0),
  quantity_status TEXT NOT NULL CHECK(quantity_status IN ('pending','manual','applying','automatic')),
  cost_revision INTEGER NOT NULL CHECK(cost_revision > 0),
  processed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(document_key, listing_id)
);

CREATE INDEX purchase_processing_listing ON purchase_processing(listing_id, processed_at);
CREATE INDEX purchase_processing_status ON purchase_processing(quantity_status, processed_at);
