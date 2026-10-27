import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, requirePerm, userCan } from '../auth';
import { today, type DB } from '../db';
import { audit, currentVersion, loadRecipeVersion, runCosting, saveCosting, toRecipeForCosting } from '../services';
import { batchCost } from './costings';
import { batchDto, nextBatchNumber, setInputLots } from './batches';
import { calculateCosting, type CostItem, type CostingInput } from '../../shared/engine';
import { dec } from '../../shared/decimal';

const optDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional();
const money = (label: string) => z.string().trim().refine((v) => v === '' || (!!dec(v) && dec(v)!.gte(0)), `${label} must be a number ≥ 0`).nullable().optional();
const feeBasis = z.enum(['per_output_qty', 'per_batch']);
const otherCost = z.object({ label: z.string().trim().min(1).max(200), amount: z.string().refine((v) => !!dec(v) && dec(v)!.gte(0), 'amount must be a number ≥ 0') });

/**
 * In-house production costs from the recipe are left out of a partner batch: the partner
 * fee replaces Kuna's own labour, setup, equipment, overhead and processing consumables.
 * Quality testing and other explicitly entered charges stay.
 */
export const INHOUSE_ONLY_CATEGORIES = ['labour', 'setup_cleaning', 'utilities_equipment', 'overhead', 'consumable'];

interface PartnerTerms { partnerName: string; feeBasis: string | null; feeRate: string | null; freightOut: string | null; freightBack: string | null; other: { label: string; amount: string }[]; outputUnit: string }

export function partnerCostItems(t: PartnerTerms): CostItem[] {
  const items: CostItem[] = [];
  items.push(t.feeBasis === 'per_batch'
    ? { category: 'outsourcing', description: `Partner fee: ${t.partnerName} (per batch)`, basis: 'fixed', rate: t.feeRate || null }
    : { category: 'outsourcing', description: `Partner fee: ${t.partnerName} (per ${t.outputUnit} received)`, basis: 'per_output_qty', rate: t.feeRate || null });
  if (t.freightOut) items.push({ category: 'outsourcing', description: 'Freight of ingredients to partner', basis: 'fixed', rate: t.freightOut });
  if (t.freightBack) items.push({ category: 'outsourcing', description: 'Freight of finished goods back to Kuna', basis: 'fixed', rate: t.freightBack });
  for (const o of t.other) items.push({ category: 'outsourcing', description: o.label, basis: 'fixed', rate: o.amount });
  return items;
}

function partnerRecipe(db: DB, versionId: number, t: PartnerTerms) {
  const { v, ingredients, costItems } = loadRecipeVersion(db, versionId);
  const recipe = toRecipeForCosting(v, ingredients, costItems);
  recipe.costItems = [...recipe.costItems.filter((c) => !INHOUSE_ONLY_CATEGORIES.includes(c.category)), ...partnerCostItems(t)];
  return recipe;
}

function termsFromBatch(b: any, outputUnit: string): PartnerTerms {
  return {
    partnerName: b.partner_name, feeBasis: b.partner_fee_basis, feeRate: b.partner_fee_rate, freightOut: b.freight_out, freightBack: b.freight_back,
    other: b.partner_other_costs_json ? JSON.parse(b.partner_other_costs_json) : [], outputUnit,
  };
}

function loadBatch(db: DB, id: number) {
  const b = db.get<any>(`SELECT b.*, pa.name AS partner_name, p.output_unit, p.name AS product_name FROM production_batches b
    JOIN products p ON p.id = b.product_id LEFT JOIN partners pa ON pa.id = b.partner_id WHERE b.id = ?`, id);
  if (!b) throw new HttpError(404, 'Batch not found.');
  if (!b.partner_id) throw new HttpError(409, 'This is not a partner batch.');
  return b;
}

const blank = (v: string | null | undefined) => (v === undefined ? undefined : v === null || v.trim() === '' ? null : v.trim().replace(',', '.'));

export function registerPartnerRoutes(app: FastifyInstance) {
  const db = app.db;

  function partnerDto(r: any, showCosts: boolean) {
    return {
      id: r.id, name: r.name, contactName: r.contact_name, email: r.email, phone: r.phone, address: r.address, notes: r.notes, archived: !!r.archived,
      feeBasis: r.fee_basis, feeRate: showCosts ? r.fee_rate : undefined,
      openBatches: r.open_batches ?? 0, totalBatches: r.total_batches ?? 0,
    };
  }

  app.get('/api/partners', async (req) => {
    requirePerm(req, 'batches.read');
    const show = userCan(req, 'costs.read');
    return db.all<any>(`SELECT pa.*,
        (SELECT COUNT(*) FROM production_batches b WHERE b.partner_id = pa.id AND b.status NOT IN ('released','rejected')) AS open_batches,
        (SELECT COUNT(*) FROM production_batches b WHERE b.partner_id = pa.id) AS total_batches
      FROM partners pa ORDER BY pa.archived, pa.name`).map((r) => partnerDto(r, show));
  });

  const partnerBody = z.object({
    name: z.string().trim().min(1).max(120),
    contactName: z.string().trim().max(120).nullable().optional(), email: z.string().trim().max(200).nullable().optional(),
    phone: z.string().trim().max(60).nullable().optional(), address: z.string().max(500).nullable().optional(), notes: z.string().max(5000).nullable().optional(),
    feeBasis: feeBasis.default('per_output_qty'), feeRate: money('Fee rate'), archived: z.boolean().optional(),
  });

  app.post('/api/partners', async (req) => {
    const me = requirePerm(req, 'batches.write', 'costs.read');
    const b = partnerBody.parse(req.body);
    const id = db.run('INSERT INTO partners (name, contact_name, email, phone, address, notes, fee_basis, fee_rate) VALUES (?,?,?,?,?,?,?,?)',
      b.name, b.contactName || null, b.email || null, b.phone || null, b.address || null, b.notes || null, b.feeBasis, blank(b.feeRate) ?? null).lastInsertRowid;
    audit(db, me, 'partner', id, 'create', `Added partner ${b.name}`);
    return partnerDto(db.get('SELECT * FROM partners WHERE id = ?', id), true);
  });

  app.patch('/api/partners/:id', async (req) => {
    const me = requirePerm(req, 'batches.write', 'costs.read');
    const id = Number((req.params as any).id);
    const before = db.get<any>('SELECT * FROM partners WHERE id = ?', id);
    if (!before) throw new HttpError(404, 'Partner not found.');
    const b = partnerBody.parse(req.body);
    db.run(`UPDATE partners SET name = ?, contact_name = ?, email = ?, phone = ?, address = ?, notes = ?, fee_basis = ?, fee_rate = ?, archived = ?, updated_at = datetime('now') WHERE id = ?`,
      b.name, b.contactName || null, b.email || null, b.phone || null, b.address || null, b.notes || null, b.feeBasis, blank(b.feeRate) ?? null, b.archived ? 1 : 0, id);
    audit(db, me, 'partner', id, 'update', `Updated partner ${b.name}. Existing batches keep the terms they were created with.`, before, b);
    return partnerDto(db.get('SELECT * FROM partners WHERE id = ?', id), true);
  });

  /** Plan a partner batch: partner estimate (fee + freight, no in-house labour) plus an in-house comparison snapshot. */
  app.post('/api/partner-batches', async (req) => {
    const me = requirePerm(req, 'batches.write', 'costs.read');
    const b = z.object({
      partnerId: z.number().int(), productId: z.number().int(), recipeVersionId: z.number().int().nullable().optional(),
      packagingFormatId: z.number().int().nullable().optional(),
      plannedQty: z.string().refine((v) => dec(v)?.gt(0), 'planned quantity must be > 0'), plannedYieldPct: z.string().nullable().optional(),
      feeBasis: feeBasis.optional(), feeRate: money('Fee rate'), freightOut: money('Freight to partner'), freightBack: money('Freight back'),
      otherCosts: z.array(otherCost).max(20).optional(),
      batchNumber: z.string().trim().max(60).nullable().optional(), notes: z.string().max(5000).nullable().optional(),
      inhouseExtraCosts: z.array(batchCost).max(30).optional(),
    }).parse(req.body);
    const partner = db.get<any>('SELECT * FROM partners WHERE id = ?', b.partnerId);
    if (!partner) throw new HttpError(400, 'Partner not found.');
    if (partner.archived) throw new HttpError(409, `${partner.name} is archived.`);
    const v = b.recipeVersionId ? db.get<any>('SELECT * FROM recipe_versions WHERE id = ? AND product_id = ?', b.recipeVersionId, b.productId) : currentVersion(db, b.productId);
    if (!v) throw new HttpError(400, 'No recipe version for this product.');
    if (v.status !== 'approved') throw new HttpError(409, `Recipe v${v.version_no} is ${v.status}. Approve a recipe version before sending production to a partner.`);
    const product = db.get<any>('SELECT * FROM products WHERE id = ?', b.productId);
    if (b.plannedYieldPct && !(dec(b.plannedYieldPct)?.gt(0) && dec(b.plannedYieldPct)!.lte(100))) throw new HttpError(400, 'Expected yield must be between 0 and 100 %.');
    const terms: PartnerTerms = {
      partnerName: partner.name, feeBasis: b.feeBasis ?? partner.fee_basis, feeRate: blank(b.feeRate) ?? partner.fee_rate,
      freightOut: blank(b.freightOut) ?? null, freightBack: blank(b.freightBack) ?? null, other: b.otherCosts ?? [], outputUnit: product.output_unit,
    };
    const common = { recipeVersionId: v.id, batchQty: b.plannedQty, yieldPctOverride: b.plannedYieldPct || null, packagingFormatId: b.packagingFormatId };
    const est = runCosting(db, { ...common, recipeOverride: partnerRecipe(db, v.id, terms) });
    const inhouse = runCosting(db, { ...common, extraCosts: b.inhouseExtraCosts });
    const id = db.tx(() => {
      const num = b.batchNumber || nextBatchNumber(db, product.code, 'P-');
      const cid = saveCosting(db, me, 'batch_estimate', `Partner batch ${num} estimate (${partner.name})`, est.input, est.result, est.version, b.packagingFormatId);
      const hid = saveCosting(db, me, 'estimate', `Partner batch ${num}: in-house comparison`, inhouse.input, inhouse.result, inhouse.version, b.packagingFormatId);
      const bid = db.run(`INSERT INTO production_batches (batch_number, product_id, recipe_version_id, packaging_format_id, planned_qty, planned_yield_pct, estimate_costing_id, notes, created_by,
          partner_id, partner_fee_basis, partner_fee_rate, freight_out, freight_back, partner_other_costs_json, inhouse_costing_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, num, b.productId, v.id, b.packagingFormatId ?? null, b.plannedQty, est.result.yieldPct, cid, b.notes || null, me.id,
        partner.id, terms.feeBasis, terms.feeRate, terms.freightOut, terms.freightBack, JSON.stringify(terms.other), hid).lastInsertRowid;
      for (const line of est.result.lines.filter((l) => l.section === 'ingredients' && l.materialId)) {
        db.run('INSERT INTO batch_inputs (batch_id, material_id, planned_qty, unit) VALUES (?,?,?,?)', bid, line.materialId, line.quantity, line.quantityUnit);
      }
      return bid;
    });
    audit(db, me, 'batch', id, 'create', `Planned partner batch for ${product.name} v${v.version_no} at ${partner.name} (${b.plannedQty} ${product.output_unit})`);
    return batchDto(db, id, true);
  });

  /** Step 1: ingredients leave Kuna. Prices are frozen at this moment (new estimate snapshot). */
  app.post('/api/partner-batches/:id/send', async (req) => {
    const me = requirePerm(req, 'batches.write', 'costs.read');
    const id = Number((req.params as any).id);
    const batch = loadBatch(db, id);
    if (batch.status !== 'planned' || batch.sent_date) throw new HttpError(409, 'The ingredients for this batch have already been sent.');
    const b = z.object({
      sentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), freightOut: money('Freight to partner'),
      lots: z.array(z.object({ inputId: z.number().int(), lot: z.string().trim().max(100).nullable() })).max(200).optional(),
    }).parse(req.body);
    db.tx(() => {
      if (b.freightOut !== undefined) db.run('UPDATE production_batches SET freight_out = ? WHERE id = ?', blank(b.freightOut), id);
      const fresh = db.get<any>('SELECT b.*, pa.name AS partner_name FROM production_batches b JOIN partners pa ON pa.id = b.partner_id WHERE b.id = ?', id);
      const est = runCosting(db, { recipeVersionId: batch.recipe_version_id, batchQty: batch.planned_qty, yieldPctOverride: batch.planned_yield_pct, packagingFormatId: batch.packaging_format_id,
        recipeOverride: partnerRecipe(db, batch.recipe_version_id, termsFromBatch(fresh, batch.output_unit)) });
      const cid = saveCosting(db, me, 'batch_estimate', `Partner batch ${batch.batch_number}: valued when sent ${b.sentDate}`, est.input, est.result, est.version, batch.packaging_format_id);
      db.run("UPDATE production_batches SET status = 'in_production', sent_date = ?, estimate_costing_id = ?, updated_at = datetime('now') WHERE id = ?", b.sentDate, cid, id);
      if (b.lots?.length) setInputLots(db, id, b.lots);
    });
    audit(db, me, 'batch', id, 'send', `Ingredients sent to ${batch.partner_name} on ${b.sentDate}`);
    return batchDto(db, id, true);
  });

  /** Step 2 (optional): the partner confirms production. */
  app.post('/api/partner-batches/:id/produced', async (req) => {
    const me = requirePerm(req, 'batches.write');
    const id = Number((req.params as any).id);
    const batch = loadBatch(db, id);
    if (!batch.sent_date) throw new HttpError(409, 'Send the ingredients first.');
    if (['released', 'rejected'].includes(batch.status)) throw new HttpError(409, `Batch is ${batch.status}; its record is closed.`);
    const b = z.object({ producedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), partnerRef: z.string().trim().max(100).nullable().optional() }).parse(req.body);
    db.run("UPDATE production_batches SET partner_produced_date = ?, partner_ref = ?, production_date = ?, updated_at = datetime('now') WHERE id = ?", b.producedDate, b.partnerRef || null, b.producedDate, id);
    audit(db, me, 'batch', id, 'produced', `Partner production confirmed ${b.producedDate}${b.partnerRef ? ` (ref. ${b.partnerRef})` : ''}`);
    return batchDto(db, id, userCan(req, 'costs.read'));
  });

  /** Step 3: finished goods received. Optionally locks the actual cost (partner fee × received output + freight). */
  app.post('/api/partner-batches/:id/receive', async (req) => {
    const me = requirePerm(req, 'batches.write', 'costs.read');
    const id = Number((req.params as any).id);
    const batch = loadBatch(db, id);
    if (!batch.sent_date) throw new HttpError(409, 'Send the ingredients first.');
    if (batch.costs_locked) throw new HttpError(409, 'The actual cost of this batch is already locked.');
    if (['released', 'rejected'].includes(batch.status)) throw new HttpError(409, `Batch is ${batch.status}; its record is closed.`);
    const b = z.object({
      receivedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      receivedQty: z.string().refine((v) => dec(v)?.gt(0), 'received sellable quantity must be > 0'),
      packagedUnits: z.string().nullable().optional(), partnerLot: z.string().trim().max(100).nullable().optional(), coaRef: z.string().trim().max(200).nullable().optional(),
      expiryDate: optDate, feeRate: money('Fee rate'), freightOut: money('Freight to partner'), freightBack: money('Freight back'), otherCosts: z.array(otherCost).max(20).optional(),
      lock: z.boolean().default(false),
    }).parse(req.body);
    if (b.packagedUnits && !(dec(b.packagedUnits)?.gte(0))) throw new HttpError(400, 'Packaged units must be a number ≥ 0.');
    db.tx(() => {
      db.run(`UPDATE production_batches SET received_date = ?, actual_output_qty = ?, actual_packaged_units = ?, partner_lot = ?, coa_ref = ?,
          expiry_date = COALESCE(?, expiry_date), production_date = COALESCE(production_date, ?),
          partner_fee_rate = CASE WHEN ? THEN ? ELSE partner_fee_rate END, freight_out = CASE WHEN ? THEN ? ELSE freight_out END,
          freight_back = CASE WHEN ? THEN ? ELSE freight_back END, partner_other_costs_json = CASE WHEN ? THEN ? ELSE partner_other_costs_json END,
          updated_at = datetime('now') WHERE id = ?`,
        b.receivedDate, b.receivedQty.replace(',', '.'), b.packagedUnits || null, b.partnerLot || null, b.coaRef || null, b.expiryDate ?? null, b.receivedDate,
        b.feeRate !== undefined, blank(b.feeRate) ?? null, b.freightOut !== undefined, blank(b.freightOut) ?? null,
        b.freightBack !== undefined, blank(b.freightBack) ?? null, b.otherCosts !== undefined, JSON.stringify(b.otherCosts ?? []), id);
      if (b.lock) {
        const fresh = db.get<any>('SELECT b.*, pa.name AS partner_name FROM production_batches b JOIN partners pa ON pa.id = b.partner_id WHERE b.id = ?', id);
        const est = db.get<any>('SELECT * FROM costings WHERE id = ?', fresh.estimate_costing_id);
        const input: CostingInput = JSON.parse(est.inputs_json);
        // Same frozen material prices as when sent; partner terms as finally invoiced.
        input.recipe.costItems = [...input.recipe.costItems.filter((c) => c.category !== 'outsourcing'), ...partnerCostItems(termsFromBatch(fresh, batch.output_unit))];
        input.actualOutputQty = fresh.actual_output_qty;
        input.actualPackagedUnits = fresh.actual_packaged_units;
        const result = calculateCosting(input);
        const version = db.get<any>('SELECT rv.*, p.name AS product_name, p.output_unit FROM recipe_versions rv JOIN products p ON p.id = rv.product_id WHERE rv.id = ?', fresh.recipe_version_id);
        const cid = saveCosting(db, me, 'batch_actual', `Partner batch ${fresh.batch_number} actual (${fresh.partner_name})`, input, result, version, fresh.packaging_format_id);
        db.run("UPDATE production_batches SET actual_costing_id = ?, costs_locked = 1, updated_at = datetime('now') WHERE id = ?", cid, id);
      }
    });
    audit(db, me, 'batch', id, b.lock ? 'lock_costs' : 'receive', `Received ${b.receivedQty} ${batch.output_unit} from ${batch.partner_name}${b.lock ? '; actual cost locked' : ''}`);
    return batchDto(db, id, true);
  });

  void today;
}
