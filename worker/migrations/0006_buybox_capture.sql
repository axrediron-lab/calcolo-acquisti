CREATE TABLE buybox_capture_jobs (
  job_id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  sku_snapshot TEXT NOT NULL,
  product_snapshot TEXT NOT NULL,
  original_quantity INTEGER NOT NULL CHECK(original_quantity = 0),
  status TEXT NOT NULL CHECK(status IN ('prepared','active','capturing','restoring','restored','restore_required')),
  created_at TEXT NOT NULL,
  activated_at TEXT,
  captured_at TEXT,
  restored_at TEXT,
  updated_at TEXT NOT NULL,
  last_error TEXT
);

CREATE UNIQUE INDEX buybox_capture_one_open_job
  ON buybox_capture_jobs(listing_id)
  WHERE status <> 'restored';

CREATE INDEX buybox_capture_jobs_recent
  ON buybox_capture_jobs(created_at DESC);

CREATE TABLE buybox_capture_markets (
  job_id TEXT NOT NULL,
  market TEXT NOT NULL,
  currency TEXT NOT NULL,
  original_price TEXT NOT NULL,
  original_min_price TEXT NOT NULL,
  max_price TEXT NOT NULL,
  temporary_price TEXT NOT NULL,
  PRIMARY KEY(job_id, market),
  FOREIGN KEY(job_id) REFERENCES buybox_capture_jobs(job_id)
);

CREATE TABLE buybox_capture_observations (
  job_id TEXT NOT NULL,
  market TEXT NOT NULL,
  classification TEXT NOT NULL CHECK(classification IN ('competitive','own_winning','no_data','invalid')),
  is_winning INTEGER,
  winner_amount TEXT,
  winner_currency TEXT,
  price_to_win_amount TEXT,
  price_to_win_currency TEXT,
  captured_at TEXT NOT NULL,
  PRIMARY KEY(job_id, market),
  FOREIGN KEY(job_id) REFERENCES buybox_capture_jobs(job_id)
);

CREATE INDEX buybox_capture_observations_latest
  ON buybox_capture_observations(market, captured_at DESC);
