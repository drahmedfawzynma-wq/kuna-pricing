import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, requirePerm, userCan } from '../auth';
import { today } from '../db';
import { audit, currentVersion, runCosting, saveCosting } from '../services';
import { batchCost } from './costings';
import { calculateCosting, type CostingInput } from '../../shared/engine';
import { Decimal, dec, str } from '../../shared/decimal';

const optDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional();

export function registerBatchRoutes(app: FastifyInstance) {
  const db = app.db;

  function batchDto(id: number, showCosts: boolean) {
    const b = db.get<any>(`SELECT b.*, p.name AS product_name, p.output_unit, rv.version_no, pf.name AS packaging_name, q.name AS qc_name
      FROM production_batches b JOIN products p ON p.id = b.product_id JOIN recipe_versions rv ON rv.id = b.recipe_version_id
      LEFT JOIN packaging_formats pf ON pf.id = b.packaging_format_id LEFT JOIN users q ON q.id = b.qc_approved_by WHERE b.id = ?`, id);
    if (!b) throw new HttpError(404, 'Batch not found.');
    const out: any = {
      id: b.id, batchNumber: b.batch_number, productId: b.product_id, productName: b.product_name, outputUnit: b.output_unit,
      recipeVersionId: b.recipe_version_id, versionNo: b.version_no, packagingFormatId: b.packaging_format_id, packagingName: b.packaging_name,
      status: b.status, plannedQty: b.planned_qty, plannedYieldPct: b.planned_yield_pct, productionDate: b.production_date, expiryDate: b.expiry_date,
      actualOutputQty: b.actual_output_qty, actualPackagedUnits: b.actual_packaged_units, costsLocked: !!b.costs_locked,
      qcApprovedAt: b.qc_approved_at, qcApprovedByName: b.qc_name, notes: b.notes, createdAt: b.created_at,
      actualAdjustments: showCosts && b.actual_costs_json ? JSON.parse(b.actual_costs_json) : [],
      specs: db.all('SELECT * FROM quality_specs WHERE product_id = ? AND active = 1 ORDER BY id', b.product_id),
      qcResults: db.all('SELECT r.*, u.name AS tested_by_name FROM quality_results r LEFT JOIN users u ON u.id = r.tested_by WHERE batch_id = ? ORDER BY r.id', id),
      inputs: db.all('SELECT bi.*, m.name AS material_name, l.supplier_lot FROM batch_inputs bi JOIN materials m ON m.id = bi.material_id LEFT JOIN material_lots l ON l.id = bi.lot_id WHERE batch_id = ?', id),
    };
    if (showCosts) {
      const est = b.estimate_costing_id ? db.get<any>('SELECT * FROM costings WHERE id = ?', b.estimate_costing_id) : null;
      const act = b.actual_costing_id ? db.get<any>('SELECT * FROM costings WHERE id = ?', b.actual_costing_id) : null;
      out.estimate = est ? { id: est.id, createdAt: est.created_at, result: JSON.parse(est.result_json) } : null;
      out.actual = act ? { id: act.id, createdAt: act.created_at, result: JSON.parse(act.result_json) } : null;
    }
    return out;
  }

  app.get('/api/batches', async (req) => {
    requirePerm(req, 'batches.read');
    const showCosts = userCan(req, 'costs.read');
    return db.all<any>(`SELECT b.*, p.name AS product_name, p.output_unit, rv.version_no, e.cost_per_output_unit AS est_cpu, a.cost_per_output_unit AS act_cpu
      FROM production_batches b JOIN products p ON p.id = b.product_id JOIN recipe_versions rv ON rv.id = b.recipe_version_id
      LEFT JOIN costings e ON e.id = b.estimate_costing_id LEFT JOIN costings a ON a.id = b.actual_costing_id ORDER BY b.id DESC LIMIT 500`).map((b) => ({
      id: b.id, batchNumber: b.batch_number, productName: b.product_name, outputUnit: b.output_unit, versionNo: b.version_no, status: b.status,
      plannedQty: b.planned_qty, actualOutputQty: b.actual_output_qty, productionDate: b.production_date, expiryDate: b.expiry_date, costsLocked: !!b.costs_locked,
      estimatedCostPerUnit: showCosts ? b.est_cpu : undefined, actualCostPerUnit: showCosts ? b.act_cpu : undefined,
    }));
  });

  app.get('/api/batches/:id', async (req) => {
    requirePerm(req, 'batches.read');
    return batchDto(Number((req.params as any).id), userCan(req, 'costs.read'));
  });

  app.post('/api/batches', async (req) => {
    const me = requirePerm(req, 'batches.write');
    const b = z.object({
      productId: z.number().int(), recipeVersionId: z.number().int().nullable().optional(), packagingFormatId: z.number().int().nullable().optional(),
      plannedQty: z.string().refine((v) => dec(v)?.gt(0), 'planned quantity must be > 0'), plannedYieldPct: z.string().nullable().optional(),
      productionDate: optDate, expiryDate: optDate, batchNumber: z.string().trim().max(60).nullable().optional(), notes: z.string().max(5000).nullable().optional(),
      extraCosts: z.array(batchCost).max(30).optional(),
    }).parse(req.body);
    const v = b.recipeVersionId ? db.get<any>('SELECT * FROM recipe_versions WHERE id = ? AND product_id = ?', b.recipeVersionId, b.productId) : currentVersion(db, b.productId);
    if (!v) throw new HttpError(400, 'No recipe version for this product.');
    if (v.status !== 'approved') throw new HttpError(409, `Recipe v${v.version_no} is ${v.status}. Approve a recipe version before planning production, so the batch refers to a locked formulation.`);
    const product = db.get<any>('SELECT * FROM products WHERE id = ?', b.productId);
    const c = runCosting(db, { recipeVersionId: v.id, batchQty: b.plannedQty, yieldPctOverride: b.plannedYieldPct || null, packagingFormatId: b.packagingFormatId, extraCosts: b.extraCosts });
    const id = db.tx(() => {
      let num = b.batchNumber;
      if (!num) {
        const stem = `${product.code.toUpperCase().slice(0, 12)}-${today().replace(/-/g, '').slice(2)}`;
        let n = 1;
        while (db.get('SELECT id FROM production_batches WHERE batch_number = ?', `${stem}-${String(n).padStart(2, '0')}`)) n++;
        num = `${stem}-${String(n).padStart(2, '0')}`;
      }
      const cid = saveCosting(db, me, 'batch_estimate', `Batch ${num} estimate`, c.input, c.result, c.version, b.packagingFormatId);
      const bid = db.run(`INSERT INTO production_batches (batch_number, product_id, recipe_version_id, packaging_format_id, planned_qty, planned_yield_pct, production_date, expiry_date, estimate_costing_id, notes, created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`, num, b.productId, v.id, b.packagingFormatId ?? null, b.plannedQty, c.result.yieldPct, b.productionDate, b.expiryDate, cid, b.notes, me.id).lastInsertRowid;
      // Planned ingredient inputs for traceability (lots assigned later).
      for (const line of c.result.lines.filter((l) => l.section === 'ingredients' && l.materialId)) {
        db.run('INSERT INTO batch_inputs (batch_id, material_id, planned_qty, unit) VALUES (?,?,?,?)', bid, line.materialId, line.quantity, line.quantityUnit);
      }
      return bid;
    });
    audit(db, me, 'batch', id, 'create', `Planned batch for ${product.name} v${v.version_no} (${b.plannedQty} ${product.output_unit})`);
    return batchDto(id, userCan(req, 'costs.read'));
  });

  const TRANSITIONS: Record<string, string[]> = {
    planned: ['in_production', 'on_hold'],
    in_production: ['on_hold'],
    on_hold: ['in_production', 'planned'],
    released: [],
    rejected: [],
  };

  app.patch('/api/batches/:id', async (req) => {
    const me = requirePerm(req, 'batches.write');
    const id = Number((req.params as any).id);
    const before = db.get<any>('SELECT * FROM production_batches WHERE id = ?', id);
    if (!before) throw new HttpError(404, 'Batch not found.');
    const b = z.object({
      status: z.enum(['planned', 'in_production', 'on_hold']).optional(),
      productionDate: optDate, expiryDate: optDate, notes: z.string().max(5000).nullable().optional(),
      actualOutputQty: z.string().nullable().optional(), actualPackagedUnits: z.string().nullable().optional(),
      actualAdjustments: z.array(z.object({ label: z.string().min(1).max(200), amount: z.string(), category: z.enum(['consumable', 'labour', 'setup_cleaning', 'testing', 'utilities_equipment', 'other']).default('labour') })).max(30).optional(),
    }).parse(req.body);
    if (['released', 'rejected'].includes(before.status)) throw new HttpError(409, `Batch is ${before.status}; its record is closed.`);
    if (b.status && b.status !== before.status && !TRANSITIONS[before.status]?.includes(b.status)) throw new HttpError(409, `Cannot move a ${before.status} batch to ${b.status}. Release and rejection are quality decisions.`);
    if (before.costs_locked && (b.actualOutputQty !== undefined || b.actualPackagedUnits !== undefined || b.actualAdjustments !== undefined)) throw new HttpError(409, 'Actual costs are locked for this batch.');
    for (const a of b.actualAdjustments ?? []) if (!dec(a.amount)) throw new HttpError(400, `Adjustment "${a.label}" needs a numeric amount.`);
    if (b.actualOutputQty && !dec(b.actualOutputQty)?.gt(0)) throw new HttpError(400, 'Actual output must be greater than zero.');
    db.run(`UPDATE production_batches SET status = COALESCE(?, status), production_date = COALESCE(?, production_date), expiry_date = COALESCE(?, expiry_date), notes = COALESCE(?, notes),
      actual_output_qty = CASE WHEN ? THEN ? ELSE actual_output_qty END, actual_packaged_units = CASE WHEN ? THEN ? ELSE actual_packaged_units END,
      actual_costs_json = CASE WHEN ? THEN ? ELSE actual_costs_json END, updated_at = datetime('now') WHERE id = ?`,
      b.status, b.productionDate, b.expiryDate, b.notes,
      b.actualOutputQty !== undefined, b.actualOutputQty || null, b.actualPackagedUnits !== undefined, b.actualPackagedUnits || null,
      b.actualAdjustments !== undefined, JSON.stringify(b.actualAdjustments ?? []), id);
    audit(db, me, 'batch', id, 'update', `Updated batch ${before.batch_number}`, before, b);
    return batchDto(id, userCan(req, 'costs.read'));
  });

  /** Lock actual costs: uses the batch's own snapshot prices (not today's), actual output and recorded adjustments. */
  app.post('/api/batches/:id/complete-costing', async (req) => {
    const me = requirePerm(req, 'batches.write', 'costs.read');
    const id = Number((req.params as any).id);
    const b = db.get<any>('SELECT * FROM production_batches WHERE id = ?', id);
    if (!b) throw new HttpError(404, 'Batch not found.');
    if (b.costs_locked) throw new HttpError(409, 'Actual costs are already locked.');
    if (!b.actual_output_qty) throw new HttpError(400, 'Enter the actual accepted output first.');
    const est = db.get<any>('SELECT * FROM costings WHERE id = ?', b.estimate_costing_id);
    const input: CostingInput = JSON.parse(est.inputs_json);
    input.actualOutputQty = b.actual_output_qty;
    input.actualPackagedUnits = b.actual_packaged_units;
    const adjustments: { label: string; amount: string; category?: string }[] = b.actual_costs_json ? JSON.parse(b.actual_costs_json) : [];
    input.recipe.costItems = [...input.recipe.costItems, ...adjustments.map((a) => ({ category: (a.category ?? 'other') as any, description: `Actual: ${a.label}`, basis: 'fixed' as const, rate: a.amount }))];
    const result = calculateCosting(input);
    const version = db.get<any>('SELECT rv.*, p.name AS product_name, p.output_unit FROM recipe_versions rv JOIN products p ON p.id = rv.product_id WHERE rv.id = ?', b.recipe_version_id);
    db.tx(() => {
      const cid = saveCosting(db, me, 'batch_actual', `Batch ${b.batch_number} actual`, input, result, version, b.packaging_format_id);
      db.run("UPDATE production_batches SET actual_costing_id = ?, costs_locked = 1, updated_at = datetime('now') WHERE id = ?", cid, id);
    });
    audit(db, me, 'batch', id, 'lock_costs', `Locked actual costs for ${b.batch_number}`);
    return batchDto(id, true);
  });

  app.post('/api/batches/:id/qc-results', async (req) => {
    const me = requirePerm(req, 'quality.write');
    const id = Number((req.params as any).id);
    const batch = db.get<any>('SELECT * FROM production_batches WHERE id = ?', id);
    if (!batch) throw new HttpError(404, 'Batch not found.');
    if (['released', 'rejected'].includes(batch.status)) throw new HttpError(409, `Batch is ${batch.status}; results are closed.`);
    const b = z.object({
      specId: z.number().int().nullable().optional(), parameter: z.string().trim().max(100).optional(), valueText: z.string().max(500),
      result: z.enum(['pass', 'fail', 'info']).optional(), testedAt: optDate, attachmentRef: z.string().max(500).nullable().optional(), notes: z.string().max(2000).nullable().optional(),
    }).parse(req.body);
    const spec = b.specId ? db.get<any>('SELECT * FROM quality_specs WHERE id = ? AND product_id = ?', b.specId, batch.product_id) : null;
    if (b.specId && !spec) throw new HttpError(400, 'Specification not found for this product.');
    let result = b.result;
    const v = dec(b.valueText);
    if (spec && v && (spec.min_value || spec.max_value)) {
      const lo = dec(spec.min_value);
      const hi = dec(spec.max_value);
      result = (lo && v.lt(lo)) || (hi && v.gt(hi)) ? 'fail' : 'pass';
    }
    if (!result) throw new HttpError(400, 'Choose pass, fail or info (no numeric limits are configured for this parameter).');
    const rid = db.run('INSERT INTO quality_results (batch_id, spec_id, parameter, value_text, result, tested_at, tested_by, attachment_ref, notes) VALUES (?,?,?,?,?,?,?,?,?)',
      id, spec?.id ?? null, spec?.parameter ?? b.parameter ?? 'Result', b.valueText, result, b.testedAt ?? today(), me.id, b.attachmentRef, b.notes).lastInsertRowid;
    audit(db, me, 'batch', id, 'qc_result', `QC ${spec?.parameter ?? b.parameter}: ${b.valueText} → ${result}`);
    return { id: rid, result };
  });

  app.post('/api/batches/:id/decision', async (req) => {
    const me = requirePerm(req, 'quality.release');
    const id = Number((req.params as any).id);
    const batch = db.get<any>('SELECT * FROM production_batches WHERE id = ?', id);
    if (!batch) throw new HttpError(404, 'Batch not found.');
    const b = z.object({ decision: z.enum(['release', 'reject', 'hold']), notes: z.string().max(2000).nullable().optional() }).parse(req.body);
    if (['released', 'rejected'].includes(batch.status)) throw new HttpError(409, `Batch is already ${batch.status}.`);
    if (b.decision === 'release') {
      if (!batch.actual_output_qty) throw new HttpError(409, 'Record the actual accepted output before release.');
      const specs = db.all<any>('SELECT * FROM quality_specs WHERE product_id = ? AND active = 1', batch.product_id);
      const results = db.all<any>('SELECT * FROM quality_results WHERE batch_id = ?', id);
      const fails = results.filter((r) => r.result === 'fail');
      if (fails.length) throw new HttpError(409, `Cannot release: failed result(s) for ${fails.map((f) => f.parameter).join(', ')}.`);
      const missing = specs.filter((s) => !results.some((r) => r.spec_id === s.id && r.result === 'pass'));
      if (missing.length) throw new HttpError(409, `Cannot release: no passing result yet for ${missing.map((s) => s.parameter).join(', ')}.`);
    }
    const status = b.decision === 'release' ? 'released' : b.decision === 'reject' ? 'rejected' : 'on_hold';
    db.run(`UPDATE production_batches SET status = ?, qc_approved_by = CASE WHEN ? = 'released' THEN ? ELSE qc_approved_by END, qc_approved_at = CASE WHEN ? = 'released' THEN datetime('now') ELSE qc_approved_at END,
      notes = CASE WHEN ? IS NOT NULL THEN COALESCE(notes || char(10), '') || ? ELSE notes END, updated_at = datetime('now') WHERE id = ?`, status, status, me.id, status, b.notes, b.notes, id);
    audit(db, me, 'batch', id, b.decision, `Quality decision: ${status}${b.notes ? ` (${b.notes})` : ''}`);
    return batchDto(id, userCan(req, 'costs.read'));
  });

  void Decimal; void str;
}
