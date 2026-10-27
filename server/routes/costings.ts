import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, requirePerm, userCan } from '../auth';
import type { DB } from '../db';
import { today } from '../db';
import { audit, runCosting, saveCosting } from '../services';
import { marginPct, markupPct, priceForMargin, priceForMarkup } from '../../shared/pricing';
import { dec, str } from '../../shared/decimal';

const recipeOverride = z.object({
  outputUnit: z.enum(['L', 'kg']).optional(),
  referenceBatchQty: z.string().nullable(),
  yieldMode: z.enum(['direct', 'stages']),
  yieldPct: z.string().nullable(),
  lossStages: z.array(z.object({ name: z.string(), pct: z.string() })),
  ingredients: z.array(z.object({ materialId: z.number().nullable(), quantity: z.string().nullable(), unit: z.enum(['g', 'kg', 'mL', 'L', 'pc']), note: z.string().nullable().optional() })),
  costItems: z.array(z.object({
    category: z.enum(['consumable', 'labour', 'setup_cleaning', 'testing', 'utilities_equipment', 'overhead', 'other']),
    description: z.string().default(''),
    basis: z.enum(['fixed', 'per_hour', 'per_batch_qty', 'per_output_qty', 'step', 'percent']),
    rate: z.string().nullable().optional(), hours: z.string().nullable().optional(), hoursScale: z.boolean().optional(),
    stepSize: z.string().nullable().optional(), percentBase: z.enum(['ingredients', 'conversion', 'production']).nullable().optional(),
    includesUtilities: z.boolean().optional(), needsReview: z.boolean().optional(),
  })),
});

export const batchCost = z.object({
  category: z.enum(['consumable', 'labour', 'setup_cleaning', 'testing', 'utilities_equipment', 'overhead', 'other']).default('labour'),
  description: z.string().max(200).default(''),
  amount: z.string().refine((v) => { const d = dec(v); return !!d && d.gte(0); }, 'batch cost amount must be a number ≥ 0'),
});

export const costingRequest = z.object({
  recipeVersionId: z.number().int(),
  batchQty: z.string().nullable().optional(),
  yieldPctOverride: z.string().nullable().optional(),
  packagingFormatId: z.number().int().nullable().optional(),
  priceOverrides: z.record(z.string(), z.string()).optional(),
  recipe: recipeOverride.optional(),
  actualOutputQty: z.string().nullable().optional(),
  actualPackagedUnits: z.string().nullable().optional(),
  extraCosts: z.array(batchCost).max(30).optional(),
});

function toReq(b: z.infer<typeof costingRequest>) {
  const po: Record<number, string> = {};
  for (const [k, v] of Object.entries(b.priceOverrides ?? {})) {
    if (v === '' || v == null) continue;
    if (!dec(v) || dec(v)!.lt(0)) throw new HttpError(400, `Scenario price for material ${k} must be a positive number.`);
    po[Number(k)] = v;
  }
  return {
    recipeVersionId: b.recipeVersionId, batchQty: b.batchQty ?? null, yieldPctOverride: b.yieldPctOverride || null,
    packagingFormatId: b.packagingFormatId ?? null, priceOverrides: Object.keys(po).length ? po : undefined,
    recipeOverride: b.recipe ? ({ ...b.recipe, outputUnit: 'L' } as any) : undefined,
    actualOutputQty: b.actualOutputQty || null,
    actualPackagedUnits: b.actualPackagedUnits || null,
    extraCosts: b.extraCosts?.length ? b.extraCosts : undefined,
  };
}

function costingDto(r: any) {
  return {
    id: r.id, kind: r.kind, name: r.name, productId: r.product_id, recipeVersionId: r.recipe_version_id, packagingFormatId: r.packaging_format_id,
    complete: !!r.complete, totalBatchCost: r.total_batch_cost, costPerOutputUnit: r.cost_per_output_unit, costPerPackage: r.cost_per_package,
    notes: r.notes, createdAt: r.created_at, createdByName: r.created_by_name, productName: r.product_name, versionNo: r.version_no,
  };
}

export function lookupApprovedPrice(db: DB, productId: number, customerId: number | null, packagingFormatId: number | null, qty: string | null) {
  const q = dec(qty) ?? dec('1')!;
  const rows = db.all<any>(
    `SELECT * FROM selling_prices WHERE product_id = ? AND status = 'approved' AND (customer_id = ? OR customer_id IS NULL)
       AND (packaging_format_id IS ? OR packaging_format_id = ?) AND (effective_from IS NULL OR effective_from <= ?) AND (effective_to IS NULL OR effective_to >= ?)
     ORDER BY customer_id IS NULL, id DESC`, productId, customerId, packagingFormatId, packagingFormatId, today(), today());
  const eligible = rows.filter((r) => dec(r.min_qty)!.lte(q));
  if (!eligible.length) return null;
  // Customer-specific before general; within that, the highest tier reached.
  const best = eligible.filter((r) => r.customer_id === eligible[0].customer_id).sort((a, b) => dec(b.min_qty)!.cmp(dec(a.min_qty)!))[0];
  return best;
}

export function registerCostingRoutes(app: FastifyInstance) {
  const db = app.db;

  app.post('/api/costings/calculate', async (req) => {
    requirePerm(req, 'costs.read');
    const b = costingRequest.parse(req.body);
    if (b.recipe) requirePerm(req, 'recipes.read');
    const { result } = runCosting(db, toReq(b));
    return result;
  });

  app.post('/api/costings', async (req) => {
    const me = requirePerm(req, 'costs.read');
    const b = costingRequest.extend({ name: z.string().max(200).nullable().optional(), notes: z.string().max(2000).nullable().optional() }).parse(req.body);
    if (b.recipe) throw new HttpError(400, 'Save the recipe draft before saving a costing, so the snapshot refers to a stored version.');
    if (b.actualOutputQty) throw new HttpError(400, 'Actual costs are recorded on a production batch, not saved as an estimate.');
    const { input, result, version } = runCosting(db, toReq(b));
    const id = saveCosting(db, me, 'estimate', b.name ?? null, input, result, version, b.packagingFormatId, b.notes);
    return { id, result };
  });

  app.get('/api/costings', async (req) => {
    requirePerm(req, 'costs.read');
    const q = req.query as any;
    const where: string[] = [];
    const params: any[] = [];
    if (q.productId) { where.push('c.product_id = ?'); params.push(Number(q.productId)); }
    if (q.kind) { where.push('c.kind = ?'); params.push(q.kind); }
    const rows = db.all(`SELECT c.*, p.name AS product_name, rv.version_no, u.name AS created_by_name FROM costings c LEFT JOIN products p ON p.id = c.product_id LEFT JOIN recipe_versions rv ON rv.id = c.recipe_version_id LEFT JOIN users u ON u.id = c.created_by ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.id DESC LIMIT 200`, ...params);
    return rows.map(costingDto);
  });

  app.get('/api/costings/:id', async (req) => {
    requirePerm(req, 'costs.read');
    const r = db.get<any>('SELECT c.*, p.name AS product_name, rv.version_no, u.name AS created_by_name FROM costings c LEFT JOIN products p ON p.id = c.product_id LEFT JOIN recipe_versions rv ON rv.id = c.recipe_version_id LEFT JOIN users u ON u.id = c.created_by WHERE c.id = ?', Number((req.params as any).id));
    if (!r) throw new HttpError(404, 'Costing not found.');
    return { ...costingDto(r), inputs: JSON.parse(r.inputs_json), result: JSON.parse(r.result_json) };
  });

  // Scenarios: experiments that never change approved records unless applied.
  const scenarioBody = z.object({
    name: z.string().trim().min(1).max(200),
    recipeVersionId: z.number().int(),
    params: z.object({
      variants: z.array(z.object({
        label: z.string().max(100),
        batchQty: z.string().nullable().optional(),
        yieldPctOverride: z.string().nullable().optional(),
        packagingFormatId: z.number().nullable().optional(),
        priceOverrides: z.record(z.string(), z.string()).optional(),
        method: z.enum(['margin', 'markup', 'manual']).optional(),
        methodValue: z.string().nullable().optional(),
      })).min(1).max(8),
    }),
    notes: z.string().max(5000).nullable().optional(),
  });

  app.get('/api/scenarios', async (req) => {
    requirePerm(req, 'pricing.read');
    return db.all<any>('SELECT s.*, p.name AS product_name, rv.version_no, u.name AS created_by_name FROM scenarios s LEFT JOIN products p ON p.id = s.product_id LEFT JOIN recipe_versions rv ON rv.id = s.recipe_version_id LEFT JOIN users u ON u.id = s.created_by ORDER BY s.updated_at DESC')
      .map((s) => ({ id: s.id, name: s.name, productId: s.product_id, productName: s.product_name, recipeVersionId: s.recipe_version_id, versionNo: s.version_no, params: JSON.parse(s.params_json), notes: s.notes, updatedAt: s.updated_at, createdByName: s.created_by_name }));
  });
  app.post('/api/scenarios', async (req) => {
    const me = requirePerm(req, 'pricing.write');
    const b = scenarioBody.parse(req.body);
    const v = db.get<any>('SELECT product_id FROM recipe_versions WHERE id = ?', b.recipeVersionId);
    if (!v) throw new HttpError(404, 'Recipe version not found.');
    const id = db.run('INSERT INTO scenarios (name, product_id, recipe_version_id, params_json, notes, created_by) VALUES (?,?,?,?,?,?)', b.name, v.product_id, b.recipeVersionId, JSON.stringify(b.params), b.notes, me.id).lastInsertRowid;
    audit(db, me, 'scenario', id, 'create', `Saved scenario "${b.name}"`);
    return { id };
  });
  app.put('/api/scenarios/:id', async (req) => {
    const me = requirePerm(req, 'pricing.write');
    const id = Number((req.params as any).id);
    const b = scenarioBody.parse(req.body);
    if (!db.get('SELECT id FROM scenarios WHERE id = ?', id)) throw new HttpError(404, 'Scenario not found.');
    const v = db.get<any>('SELECT product_id FROM recipe_versions WHERE id = ?', b.recipeVersionId);
    if (!v) throw new HttpError(404, 'Recipe version not found.');
    db.run("UPDATE scenarios SET name=?, product_id=?, recipe_version_id=?, params_json=?, notes=?, updated_at=datetime('now') WHERE id=?", b.name, v.product_id, b.recipeVersionId, JSON.stringify(b.params), b.notes, id);
    audit(db, me, 'scenario', id, 'update', `Updated scenario "${b.name}"`);
    return { ok: true };
  });
  app.delete('/api/scenarios/:id', async (req) => {
    const me = requirePerm(req, 'pricing.write');
    const id = Number((req.params as any).id);
    db.run('DELETE FROM scenarios WHERE id = ?', id);
    audit(db, me, 'scenario', id, 'delete', 'Deleted scenario');
    return { ok: true };
  });

  // Selling prices
  function priceDto(r: any, full: boolean) {
    const base: any = {
      id: r.id, productId: r.product_id, productName: r.product_name, customerId: r.customer_id, customerName: r.customer_name,
      packagingFormatId: r.packaging_format_id, packagingName: r.packaging_name, minQty: r.min_qty, price: r.price, priceUnit: r.price_unit,
      currency: r.currency, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, status: r.status, notes: r.notes,
      approvedAt: r.approved_at, approvedByName: r.approved_by_name, createdAt: r.created_at,
    };
    if (full) {
      base.method = r.method;
      base.methodValue = r.method_value;
      base.costingId = r.costing_id;
      base.unitCostAtApproval = r.unit_cost_at_approval;
      const m = r.unit_cost_at_approval ? marginPct(r.price, r.unit_cost_at_approval) : null;
      base.marginAtApproval = m?.ok ? m.value : null;
    }
    return base;
  }
  const priceSelect = `SELECT sp.*, p.name AS product_name, c.name AS customer_name, pf.name AS packaging_name, a.name AS approved_by_name
    FROM selling_prices sp JOIN products p ON p.id = sp.product_id LEFT JOIN customers c ON c.id = sp.customer_id
    LEFT JOIN packaging_formats pf ON pf.id = sp.packaging_format_id LEFT JOIN users a ON a.id = sp.approved_by`;

  app.get('/api/prices', async (req) => {
    const full = userCan(req, 'pricing.read');
    if (!full) requirePerm(req, 'prices.read');
    const q = req.query as any;
    const where = [full ? '1=1' : "sp.status = 'approved'"];
    const params: any[] = [];
    if (q.productId) { where.push('sp.product_id = ?'); params.push(Number(q.productId)); }
    if (q.customerId) { where.push('(sp.customer_id = ? OR sp.customer_id IS NULL)'); params.push(Number(q.customerId)); }
    return db.all(`${priceSelect} WHERE ${where.join(' AND ')} ORDER BY p.name, sp.customer_id, sp.packaging_format_id, CAST(sp.min_qty AS REAL), sp.id DESC`, ...params).map((r) => priceDto(r, full));
  });

  app.get('/api/prices/lookup', async (req) => {
    const full = userCan(req, 'pricing.read');
    if (!full) requirePerm(req, 'prices.read');
    const q = req.query as any;
    const r = lookupApprovedPrice(db, Number(q.productId), q.customerId ? Number(q.customerId) : null, q.packagingFormatId ? Number(q.packagingFormatId) : null, q.qty ?? '1');
    if (!r) return null;
    return priceDto(db.get(`${priceSelect} WHERE sp.id = ?`, r.id), full);
  });

  const priceBody = costingRequest.omit({ recipe: true }).extend({
    customerId: z.number().int().nullable().optional(),
    minQty: z.string().default('1'),
    priceUnit: z.enum(['package', 'output_unit']),
    method: z.enum(['margin', 'markup', 'manual']),
    methodValue: z.string().nullable().optional(),
    price: z.string().nullable().optional(),
    effectiveFrom: z.string().nullable().optional(),
    effectiveTo: z.string().nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
  });

  /** Propose a selling price; the supporting costing is snapshotted. */
  app.post('/api/prices', async (req) => {
    const me = requirePerm(req, 'pricing.write');
    const b = priceBody.parse(req.body);
    if (b.priceOverrides && Object.keys(b.priceOverrides).length) throw new HttpError(400, 'Selling prices must be based on current material prices, not scenario prices. Update material prices first or keep this as a scenario.');
    if (b.priceUnit === 'package' && !b.packagingFormatId) throw new HttpError(400, 'Choose a packaging format for a per-package price.');
    if (!dec(b.minQty) || dec(b.minQty)!.lte(0)) throw new HttpError(400, 'Minimum quantity must be greater than zero.');
    b.minQty = str(dec(b.minQty))!;
    if (b.actualOutputQty) throw new HttpError(400, 'Selling prices are based on estimated output, not actual batch output.');
    const { input, result, version } = runCosting(db, toReq(b));
    const unitCost = b.priceUnit === 'package' ? result.costPerPackage : result.costPerOutputUnit;
    let price: string;
    if (b.method === 'manual') {
      const p = dec(b.price);
      if (!p || p.lte(0)) throw new HttpError(400, 'Enter a selling price greater than zero.');
      price = p.toDecimalPlaces(2).toFixed(2);
    } else {
      if (!unitCost) throw new HttpError(400, 'Unit cost is unavailable (incomplete costing), so a price cannot be calculated from a margin or markup.');
      const r = b.method === 'margin' ? priceForMargin(unitCost, b.methodValue) : priceForMarkup(unitCost, b.methodValue);
      if (!r.ok) throw new HttpError(400, r.error);
      price = r.value;
    }
    const id = db.tx(() => {
      const cid = saveCosting(db, me, 'price_approval', `Price proposal`, input, result, version, b.packagingFormatId);
      return db.run(
        `INSERT INTO selling_prices (product_id, customer_id, packaging_format_id, min_qty, price, price_unit, currency, effective_from, effective_to, status, method, method_value, costing_id, unit_cost_at_approval, notes, created_by)
         VALUES (?,?,?,?,?,?, 'SEK', ?, ?, 'proposed', ?, ?, ?, ?, ?, ?)`,
        version.product_id, b.customerId ?? null, b.priceUnit === 'package' ? b.packagingFormatId : null, b.minQty, price, b.priceUnit,
        b.effectiveFrom || today(), b.effectiveTo || null, b.method, b.methodValue ?? null, cid, unitCost, b.notes, me.id,
      ).lastInsertRowid;
    });
    audit(db, me, 'selling_price', id, 'propose', `Proposed ${price} SEK per ${b.priceUnit === 'package' ? 'package' : version.output_unit} for ${version.product_name}`);
    const m = unitCost ? marginPct(price, unitCost) : null;
    const mk = unitCost ? markupPct(price, unitCost) : null;
    return { id, price, unitCost, marginPct: m?.ok ? m.value : null, markupPct: mk?.ok ? mk.value : null, complete: result.complete };
  });

  app.post('/api/prices/:id/approve', async (req) => {
    const me = requirePerm(req, 'pricing.approve');
    const id = Number((req.params as any).id);
    const sp = db.get<any>('SELECT * FROM selling_prices WHERE id = ?', id);
    if (!sp) throw new HttpError(404, 'Price not found.');
    if (sp.status !== 'proposed') throw new HttpError(409, `Price is already ${sp.status}.`);
    const c = db.get<any>('SELECT complete FROM costings WHERE id = ?', sp.costing_id);
    if (c && !c.complete) throw new HttpError(409, 'The costing behind this price is incomplete (missing prices or unresolved values). Complete the costing and propose again.');
    db.tx(() => {
      db.run(`UPDATE selling_prices SET status = 'superseded', effective_to = COALESCE(effective_to, ?) WHERE status = 'approved' AND product_id = ? AND customer_id IS ? AND packaging_format_id IS ? AND min_qty = ? AND price_unit = ?`,
        today(), sp.product_id, sp.customer_id, sp.packaging_format_id, sp.min_qty, sp.price_unit);
      db.run("UPDATE selling_prices SET status = 'approved', approved_by = ?, approved_at = datetime('now') WHERE id = ?", me.id, id);
    });
    audit(db, me, 'selling_price', id, 'approve', `Approved selling price ${sp.price} SEK`);
    return { ok: true };
  });

  app.post('/api/prices/:id/reject', async (req) => {
    const me = requirePerm(req, 'pricing.approve');
    const id = Number((req.params as any).id);
    db.run("UPDATE selling_prices SET status = 'rejected' WHERE id = ? AND status = 'proposed'", id);
    audit(db, me, 'selling_price', id, 'reject', 'Rejected proposed price');
    return { ok: true };
  });
}
