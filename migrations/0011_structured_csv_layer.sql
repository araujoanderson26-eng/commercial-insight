-- Camada estruturada aditiva para importação e homologação dos CSVs oficiais do Power BI.
-- Mantém 100% de compatibilidade e isolamento em relação às tabelas e migrações 0001..0010.

CREATE TABLE IF NOT EXISTS ci_csv_batches (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  owner TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('staging','processing','validated','active','failed','rolled_back')),
  source_label TEXT NOT NULL,
  reference_date TEXT,
  coverage_from TEXT,
  coverage_to TEXT,
  file_count INTEGER NOT NULL DEFAULT 0,
  sales_rows INTEGER NOT NULL DEFAULT 0,
  return_rows INTEGER NOT NULL DEFAULT 0,
  customer_rows INTEGER NOT NULL DEFAULT 0,
  product_rows INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT,
  diff_json TEXT,
  validation_json TEXT,
  error TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  activated_at INTEGER
);

CREATE TABLE IF NOT EXISTS ci_csv_files (
  batch_id TEXT NOT NULL REFERENCES ci_csv_batches(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  filename TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  object_key TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'staged',
  schema_json TEXT,
  updated INTEGER NOT NULL,
  PRIMARY KEY(batch_id, role)
);

CREATE TABLE IF NOT EXISTS ci_dim_customers (
  batch_id TEXT NOT NULL REFERENCES ci_csv_batches(id) ON DELETE CASCADE,
  client_key TEXT NOT NULL,
  client_raw TEXT NOT NULL,
  name TEXT,
  representative_key TEXT,
  representative_raw TEXT,
  state_key TEXT,
  regional_raw TEXT,
  segment TEXT,
  sale_type TEXT,
  source_rows INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(batch_id, client_key)
);
CREATE INDEX IF NOT EXISTS ci_dim_customers_rep ON ci_dim_customers(batch_id, representative_key, client_key);
CREATE INDEX IF NOT EXISTS ci_dim_customers_state ON ci_dim_customers(batch_id, state_key, client_key);
CREATE INDEX IF NOT EXISTS ci_dim_customers_seg ON ci_dim_customers(batch_id, segment);

CREATE TABLE IF NOT EXISTS ci_dim_products (
  batch_id TEXT NOT NULL REFERENCES ci_csv_batches(id) ON DELETE CASCADE,
  product_key TEXT NOT NULL,
  product_raw TEXT NOT NULL,
  description TEXT,
  brand TEXT,
  macro_category_key TEXT,
  macro_category_raw TEXT,
  unit_liters INTEGER,
  box_liters INTEGER,
  pack_qty INTEGER,
  unit_measure TEXT,
  abc_class TEXT,
  PRIMARY KEY(batch_id, product_key)
);
CREATE INDEX IF NOT EXISTS ci_dim_products_macro ON ci_dim_products(batch_id, macro_category_key);
CREATE INDEX IF NOT EXISTS ci_dim_products_brand ON ci_dim_products(batch_id, brand);

CREATE TABLE IF NOT EXISTS ci_dim_regions (
  batch_id TEXT NOT NULL REFERENCES ci_csv_batches(id) ON DELETE CASCADE,
  state_key TEXT NOT NULL,
  state_name TEXT,
  regional_key TEXT,
  regional_raw TEXT,
  manager_key TEXT,
  manager_raw TEXT,
  region_name TEXT,
  PRIMARY KEY(batch_id, state_key)
);
CREATE INDEX IF NOT EXISTS ci_dim_regions_regional ON ci_dim_regions(batch_id, regional_key);
CREATE INDEX IF NOT EXISTS ci_dim_regions_manager ON ci_dim_regions(batch_id, manager_key);

CREATE TABLE IF NOT EXISTS ci_dim_calendar (
  batch_id TEXT NOT NULL REFERENCES ci_csv_batches(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  month_key TEXT NOT NULL,
  quarter INTEGER,
  PRIMARY KEY(batch_id, date)
);

CREATE TABLE IF NOT EXISTS ci_fact_sales (
  batch_id TEXT NOT NULL REFERENCES ci_csv_batches(id) ON DELETE CASCADE,
  row_no INTEGER NOT NULL,
  date TEXT NOT NULL,
  month_key TEXT NOT NULL,
  doc_no TEXT,
  client_key TEXT,
  client_raw TEXT,
  product_key TEXT,
  product_raw TEXT,
  group_key TEXT,
  group_raw TEXT,
  macro_key TEXT,
  state_key TEXT,
  municipality TEXT,
  channel TEXT,
  regional_raw TEXT,
  utilization TEXT,
  qty INTEGER,
  liters INTEGER,
  gross_amount INTEGER NOT NULL,
  accounting_amount INTEGER,
  PRIMARY KEY(batch_id, row_no)
);
CREATE INDEX IF NOT EXISTS ci_fact_sales_date ON ci_fact_sales(batch_id, date, client_key, gross_amount);
CREATE INDEX IF NOT EXISTS ci_fact_sales_month ON ci_fact_sales(batch_id, month_key, state_key);
CREATE INDEX IF NOT EXISTS ci_fact_sales_client ON ci_fact_sales(batch_id, client_key, date);
CREATE INDEX IF NOT EXISTS ci_fact_sales_product ON ci_fact_sales(batch_id, product_key, date);
CREATE INDEX IF NOT EXISTS ci_fact_sales_group ON ci_fact_sales(batch_id, group_key, date);
CREATE INDEX IF NOT EXISTS ci_fact_sales_macro ON ci_fact_sales(batch_id, macro_key, date);
CREATE INDEX IF NOT EXISTS ci_fact_sales_doc ON ci_fact_sales(batch_id, doc_no);

CREATE TABLE IF NOT EXISTS ci_fact_returns (
  batch_id TEXT NOT NULL REFERENCES ci_csv_batches(id) ON DELETE CASCADE,
  row_no INTEGER NOT NULL,
  date TEXT NOT NULL,
  month_key TEXT NOT NULL,
  doc_no TEXT,
  client_key TEXT,
  client_raw TEXT,
  product_key TEXT,
  product_raw TEXT,
  group_key TEXT,
  group_raw TEXT,
  macro_key TEXT,
  state_key TEXT,
  qty INTEGER,
  liters INTEGER,
  return_amount INTEGER NOT NULL,
  PRIMARY KEY(batch_id, row_no)
);
CREATE INDEX IF NOT EXISTS ci_fact_returns_date ON ci_fact_returns(batch_id, date, client_key, return_amount);
CREATE INDEX IF NOT EXISTS ci_fact_returns_client ON ci_fact_returns(batch_id, client_key, date);
CREATE INDEX IF NOT EXISTS ci_fact_returns_product ON ci_fact_returns(batch_id, product_key, date);

CREATE TABLE IF NOT EXISTS ci_fact_orders_open (
  batch_id TEXT NOT NULL REFERENCES ci_csv_batches(id) ON DELETE CASCADE,
  row_no INTEGER NOT NULL,
  doc_no TEXT,
  doc_date TEXT,
  client_key TEXT,
  client_raw TEXT,
  state_key TEXT,
  status TEXT,
  utilization TEXT,
  open_amount INTEGER,
  original_amount INTEGER,
  PRIMARY KEY(batch_id, row_no)
);

CREATE TABLE IF NOT EXISTS ci_agg_monthly (
  batch_id TEXT NOT NULL REFERENCES ci_csv_batches(id) ON DELETE CASCADE,
  month_key TEXT NOT NULL,
  state_key TEXT NOT NULL DEFAULT '',
  regional_key TEXT NOT NULL DEFAULT '',
  manager_key TEXT NOT NULL DEFAULT '',
  representative_key TEXT NOT NULL DEFAULT '',
  macro_key TEXT NOT NULL DEFAULT '',
  group_key TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT '',
  segment TEXT NOT NULL DEFAULT '',
  brand TEXT NOT NULL DEFAULT '',
  gross_amount INTEGER NOT NULL DEFAULT 0,
  return_amount INTEGER NOT NULL DEFAULT 0,
  net_amount INTEGER NOT NULL DEFAULT 0,
  sales_rows INTEGER NOT NULL DEFAULT 0,
  return_rows INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(batch_id, month_key, state_key, regional_key, manager_key, representative_key, macro_key, group_key, channel, segment, brand)
);

CREATE TABLE IF NOT EXISTS ci_dim_catalog (
  batch_id TEXT NOT NULL REFERENCES ci_csv_batches(id) ON DELETE CASCADE,
  dimension TEXT NOT NULL,
  value_key TEXT NOT NULL,
  display TEXT NOT NULL,
  extra TEXT,
  PRIMARY KEY(batch_id, dimension, value_key)
);

CREATE TABLE IF NOT EXISTS ci_csv_active (
  id INTEGER PRIMARY KEY CHECK(id=1),
  active_batch_id TEXT REFERENCES ci_csv_batches(id),
  previous_batch_id TEXT REFERENCES ci_csv_batches(id),
  mode TEXT NOT NULL DEFAULT 'shadow' CHECK(mode IN ('shadow','active')),
  updated INTEGER NOT NULL,
  actor TEXT
);

INSERT OR IGNORE INTO ci_csv_active(id, mode, updated) VALUES (1, 'shadow', 0);
