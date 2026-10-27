-- Outsourced production: co-manufacturers (partners) that make Kuna products from
-- ingredients Kuna sends. A partner batch is a production batch with a partner_id, so it
-- shares batch numbers, quality results, release and cost snapshots with in-house batches.
CREATE TABLE partners (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  fee_basis TEXT NOT NULL DEFAULT 'per_output_qty' CHECK (fee_basis IN ('per_output_qty', 'per_batch')),
  fee_rate TEXT,
  notes TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE production_batches ADD COLUMN partner_id INTEGER REFERENCES partners(id);
-- Fee terms are copied from the partner when the batch is created, so later changes to the
-- partner's terms do not alter an existing batch.
ALTER TABLE production_batches ADD COLUMN partner_fee_basis TEXT;
ALTER TABLE production_batches ADD COLUMN partner_fee_rate TEXT;
ALTER TABLE production_batches ADD COLUMN freight_out TEXT;
ALTER TABLE production_batches ADD COLUMN freight_back TEXT;
ALTER TABLE production_batches ADD COLUMN partner_other_costs_json TEXT;
ALTER TABLE production_batches ADD COLUMN sent_date TEXT;
ALTER TABLE production_batches ADD COLUMN partner_produced_date TEXT;
ALTER TABLE production_batches ADD COLUMN partner_ref TEXT;
ALTER TABLE production_batches ADD COLUMN received_date TEXT;
ALTER TABLE production_batches ADD COLUMN partner_lot TEXT;
ALTER TABLE production_batches ADD COLUMN coa_ref TEXT;
-- Snapshot of what the same batch would cost made at Kuna (make-or-buy comparison).
ALTER TABLE production_batches ADD COLUMN inhouse_costing_id INTEGER REFERENCES costings(id);

-- Supplier lot numbers typed in when ingredients are sent (no stock module).
ALTER TABLE batch_inputs ADD COLUMN lot_text TEXT;

CREATE INDEX idx_batches_partner ON production_batches(partner_id);
