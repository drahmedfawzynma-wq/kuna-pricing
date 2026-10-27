-- Kuna Production & Pricing: initial schema.
-- Decimal values (money, quantities, rates) are stored as TEXT decimal strings
-- and calculated with decimal.js; never as floating point.

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','production','quality','sales')),
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,            -- sha256 of the session token
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER,
  user_name TEXT,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  action TEXT NOT NULL,
  summary TEXT,
  before_json TEXT,
  after_json TEXT
);
CREATE INDEX audit_entity ON audit_log(entity, entity_id);

CREATE TABLE import_batches (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,             -- batchworks_materials | batchworks_costing | materials_csv
  filename TEXT,
  raw_text TEXT NOT NULL,
  parsed_json TEXT,
  decisions_json TEXT,
  status TEXT NOT NULL DEFAULT 'preview' CHECK (status IN ('preview','applied','discarded')),
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  applied_at TEXT
);

CREATE TABLE materials (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'raw',  -- raw | water | processing_aid | consumable | packaging
  supplier TEXT,
  supplier_code TEXT,
  base_unit TEXT NOT NULL CHECK (base_unit IN ('kg','L','pc')),
  density_kg_per_l TEXT,
  purity_pct TEXT,
  allergen_info TEXT,
  notes TEXT,
  review_status TEXT NOT NULL DEFAULT 'ok' CHECK (review_status IN ('ok','needs_review')),
  review_notes TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  import_batch_id INTEGER REFERENCES import_batches(id),
  import_original_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE material_prices (
  id INTEGER PRIMARY KEY,
  material_id INTEGER NOT NULL REFERENCES materials(id),
  effective_date TEXT,            -- NULL only for undated imported history
  entry_mode TEXT NOT NULL CHECK (entry_mode IN ('per_unit','per_pack')),
  pack_qty TEXT,                  -- per_pack: purchase pack size …
  pack_unit TEXT,                 -- … and its unit (g, kg, mL, L, pc)
  price TEXT NOT NULL,            -- price in `currency`, per base unit or per pack
  currency TEXT NOT NULL DEFAULT 'SEK',
  exchange_rate TEXT NOT NULL DEFAULT '1',  -- SEK per 1 unit of currency
  rate_date TEXT,
  rate_source TEXT,
  charges_sek TEXT NOT NULL DEFAULT '0',     -- freight + other allocated charges, SEK, same basis as price
  landed_unit_price_sek TEXT NOT NULL,       -- calculated SEK per base unit
  source TEXT NOT NULL DEFAULT 'manual',     -- manual | csv | batchworks
  undated INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX material_prices_mat ON material_prices(material_id, effective_date);

CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  description TEXT,
  output_unit TEXT NOT NULL DEFAULT 'L' CHECK (output_unit IN ('L','kg')),
  target_margin_pct TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE recipe_versions (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  version_no INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','archived')),
  reference_batch_qty TEXT,
  default_batch_qty TEXT,
  yield_mode TEXT NOT NULL DEFAULT 'direct' CHECK (yield_mode IN ('direct','stages')),
  yield_pct TEXT,
  loss_stages_json TEXT NOT NULL DEFAULT '[]',
  instructions TEXT,
  notes TEXT,
  review_status TEXT NOT NULL DEFAULT 'ok' CHECK (review_status IN ('ok','needs_review')),
  review_notes TEXT,
  import_batch_id INTEGER REFERENCES import_batches(id),
  import_original_json TEXT,
  based_on_version_id INTEGER REFERENCES recipe_versions(id),
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_by INTEGER,
  approved_at TEXT,
  UNIQUE (product_id, version_no)
);

CREATE TABLE recipe_ingredients (
  id INTEGER PRIMARY KEY,
  recipe_version_id INTEGER NOT NULL REFERENCES recipe_versions(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  material_id INTEGER REFERENCES materials(id),
  quantity TEXT,
  unit TEXT NOT NULL CHECK (unit IN ('g','kg','mL','L','pc')),
  note TEXT,
  needs_review INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE recipe_cost_items (
  id INTEGER PRIMARY KEY,
  recipe_version_id INTEGER NOT NULL REFERENCES recipe_versions(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  basis TEXT NOT NULL,
  rate TEXT,
  hours TEXT,
  hours_scale INTEGER NOT NULL DEFAULT 0,
  step_size TEXT,
  percent_base TEXT,
  includes_utilities INTEGER NOT NULL DEFAULT 0,
  needs_review INTEGER NOT NULL DEFAULT 0,
  note TEXT
);

CREATE TABLE packaging_formats (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  name TEXT NOT NULL,
  fill_qty TEXT,
  fill_unit TEXT NOT NULL DEFAULT 'L',
  needs_review INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE packaging_components (
  id INTEGER PRIMARY KEY,
  format_id INTEGER NOT NULL REFERENCES packaging_formats(id) ON DELETE CASCADE,
  material_id INTEGER REFERENCES materials(id),
  qty_per_package TEXT
);

-- Immutable costing snapshots: everything needed to reproduce the figures.
CREATE TABLE costings (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('estimate','scenario','quotation','price_approval','batch_estimate','batch_actual')),
  name TEXT,
  product_id INTEGER REFERENCES products(id),
  recipe_version_id INTEGER REFERENCES recipe_versions(id),
  packaging_format_id INTEGER,
  inputs_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  complete INTEGER NOT NULL,
  total_batch_cost TEXT,
  cost_per_output_unit TEXT,
  cost_per_package TEXT,
  notes TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE scenarios (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  product_id INTEGER REFERENCES products(id),
  recipe_version_id INTEGER REFERENCES recipe_versions(id),
  params_json TEXT NOT NULL,
  notes TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  org_number TEXT,
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  currency TEXT NOT NULL DEFAULT 'SEK',
  default_vat_pct TEXT NOT NULL DEFAULT '25',
  notes TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE selling_prices (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  customer_id INTEGER REFERENCES customers(id),
  packaging_format_id INTEGER REFERENCES packaging_formats(id),
  min_qty TEXT NOT NULL DEFAULT '1',
  price TEXT NOT NULL,
  price_unit TEXT NOT NULL CHECK (price_unit IN ('package','output_unit')),
  currency TEXT NOT NULL DEFAULT 'SEK',
  effective_from TEXT,
  effective_to TEXT,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','superseded','rejected')),
  method TEXT,
  method_value TEXT,
  costing_id INTEGER REFERENCES costings(id),
  unit_cost_at_approval TEXT,
  notes TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_by INTEGER,
  approved_at TEXT
);

CREATE TABLE quotations (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','cancelled')),
  currency TEXT NOT NULL DEFAULT 'SEK',
  quote_date TEXT NOT NULL,
  valid_until TEXT,
  delivery_charge TEXT NOT NULL DEFAULT '0',
  delivery_note TEXT,
  vat_pct TEXT NOT NULL DEFAULT '25',
  notes TEXT,
  customer_snapshot_json TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_by INTEGER,
  approved_at TEXT
);

CREATE TABLE quotation_lines (
  id INTEGER PRIMARY KEY,
  quotation_id INTEGER NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id),
  recipe_version_id INTEGER REFERENCES recipe_versions(id),
  packaging_format_id INTEGER REFERENCES packaging_formats(id),
  description TEXT,
  quantity TEXT NOT NULL,
  price_unit TEXT NOT NULL DEFAULT 'package',
  unit_price TEXT NOT NULL,
  line_total TEXT NOT NULL,
  selling_price_id INTEGER REFERENCES selling_prices(id),
  costing_id INTEGER REFERENCES costings(id)
);

-- Phase 2/3: production records, lots, traceability, quality.
CREATE TABLE production_batches (
  id INTEGER PRIMARY KEY,
  batch_number TEXT NOT NULL UNIQUE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  recipe_version_id INTEGER NOT NULL REFERENCES recipe_versions(id),
  packaging_format_id INTEGER REFERENCES packaging_formats(id),
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','in_production','on_hold','released','rejected')),
  planned_qty TEXT NOT NULL,
  planned_yield_pct TEXT,
  production_date TEXT,
  expiry_date TEXT,
  estimate_costing_id INTEGER REFERENCES costings(id),
  actual_output_qty TEXT,
  actual_packaged_units TEXT,
  actual_costs_json TEXT,
  actual_costing_id INTEGER REFERENCES costings(id),
  costs_locked INTEGER NOT NULL DEFAULT 0,
  qc_approved_by INTEGER,
  qc_approved_at TEXT,
  notes TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE material_lots (
  id INTEGER PRIMARY KEY,
  material_id INTEGER NOT NULL REFERENCES materials(id),
  supplier_lot TEXT NOT NULL,
  received_date TEXT,
  expiry_date TEXT,
  qty TEXT,
  unit TEXT,
  unit_cost_sek TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE batch_inputs (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES production_batches(id) ON DELETE CASCADE,
  material_id INTEGER NOT NULL REFERENCES materials(id),
  lot_id INTEGER REFERENCES material_lots(id),
  planned_qty TEXT,
  actual_qty TEXT,
  unit TEXT
);

CREATE TABLE quality_specs (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  parameter TEXT NOT NULL,
  unit TEXT,
  min_value TEXT,
  max_value TEXT,
  target_text TEXT,
  method TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE quality_results (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES production_batches(id) ON DELETE CASCADE,
  spec_id INTEGER REFERENCES quality_specs(id),
  parameter TEXT NOT NULL,
  value_text TEXT,
  result TEXT NOT NULL CHECK (result IN ('pass','fail','info')),
  tested_at TEXT,
  tested_by INTEGER,
  attachment_ref TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
