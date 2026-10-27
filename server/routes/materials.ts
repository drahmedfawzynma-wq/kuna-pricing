import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, requirePerm, userCan } from '../auth';
import { today } from '../db';
import { audit, currentPriceRows, productsUsingMaterial, runCosting, currentVersion } from '../services';
import { landedUnitPrice } from '../../shared/materialPrice';
import { toCsv } from '../csv';
import { marginPct } from '../../shared/pricing';
import { dec } from '../../shared/decimal';

const decStr = z.string().trim().refine((s) => s === '' || dec(s) !== null, 'must be a number').transform((s) => (s === '' ? null : s));
const optDec = decStr.nullable().optional();

export const materialBody = z.object({
  code: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(200),
  category: z.enum(['raw', 'water', 'processing_aid', 'consumable', 'packaging']),
  supplier: z.string().trim().max(200).nullable().optional(),
  supplierCode: z.string().trim().max(100).nullable().optional(),
  baseUnit: z.enum(['kg', 'L', 'pc']),
  densityKgPerL: optDec,
  purityPct: optDec,
  allergenInfo: z.string().max(2000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});

export const priceBody = z.object({
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD'),
  entryMode: z.enum(['per_unit', 'per_pack']),
  packQty: optDec,
  packUnit: z.enum(['g', 'kg', 'mL', 'L', 'pc']).nullable().optional(),
  price: z.string(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, '3-letter currency code'),
  exchangeRate: optDec,
  rateDate: z.string().nullable().optional(),
  rateSource: z.string().max(200).nullable().optional(),
  chargesSek: optDec,
  notes: z.string().max(2000).nullable().optional(),
});

export function registerMaterialRoutes(app: FastifyInstance) {
  const db = app.db;

  function publicMaterial(m: any, price: any, withPrices: boolean) {
    const base = {
      id: m.id, code: m.code, name: m.name, category: m.category, supplier: m.supplier, supplierCode: m.supplier_code,
      baseUnit: m.base_unit, densityKgPerL: m.density_kg_per_l, purityPct: m.purity_pct, allergenInfo: m.allergen_info,
      notes: m.notes, reviewStatus: m.review_status, archived: !!m.archived, updatedAt: m.updated_at,
    };
    if (!withPrices) return base;
    return {
      ...base,
      reviewNotes: m.review_notes,
      importOriginal: m.import_original_json ? JSON.parse(m.import_original_json) : null,
      currentPrice: price ? {
        id: price.id, effectiveDate: price.effective_date, landedUnitPriceSek: price.landed_unit_price_sek, entryMode: price.entry_mode,
        price: price.price, currency: price.currency, exchangeRate: price.exchange_rate, rateDate: price.rate_date, packQty: price.pack_qty,
        packUnit: price.pack_unit, chargesSek: price.charges_sek, source: price.source,
      } : null,
    };
  }

  app.get('/api/materials', async (req) => {
    requirePerm(req, 'materials.read');
    const q = req.query as any;
    const withPrices = userCan(req, 'materials.prices');
    const rows = db.all(`SELECT m.*, (SELECT COUNT(DISTINCT rv.product_id) FROM recipe_ingredients ri JOIN recipe_versions rv ON rv.id = ri.recipe_version_id WHERE ri.material_id = m.id AND rv.status != 'archived')
        + (SELECT COUNT(*) FROM packaging_components pc JOIN packaging_formats pf ON pf.id = pc.format_id WHERE pc.material_id = m.id AND pf.archived = 0) AS usage_count
      FROM materials m ${q.archived === '1' ? '' : 'WHERE m.archived = 0'} ORDER BY m.category = 'packaging', m.name`);
    const prices = withPrices ? currentPriceRows(db) : new Map();
    return rows.map((m) => ({ ...publicMaterial(m, prices.get(m.id), withPrices), usageCount: m.usage_count }));
  });

  app.get('/api/materials/export.csv', async (req, reply) => {
    requirePerm(req, 'materials.read', 'materials.prices');
    const prices = currentPriceRows(db);
    const rows = db.all('SELECT * FROM materials ORDER BY code');
    const csv = toCsv(
      ['code', 'name', 'category', 'supplier', 'supplier_code', 'base_unit', 'density_kg_per_l', 'archived', 'review_status', 'effective_date', 'entry_mode', 'pack_qty', 'pack_unit', 'price', 'currency', 'exchange_rate', 'rate_date', 'charges_sek', 'landed_unit_price_sek', 'notes'],
      rows.map((m) => {
        const p = prices.get(m.id);
        return [m.code, m.name, m.category, m.supplier, m.supplier_code, m.base_unit, m.density_kg_per_l, m.archived, m.review_status,
          p?.effective_date, p?.entry_mode, p?.pack_qty, p?.pack_unit, p?.price, p?.currency, p?.exchange_rate, p?.rate_date, p?.charges_sek, p?.landed_unit_price_sek, m.notes];
      }),
    );
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="kuna-materials-${today()}.csv"`);
    return csv;
  });

  app.get('/api/materials/:id', async (req) => {
    requirePerm(req, 'materials.read');
    const id = Number((req.params as any).id);
    const m = db.get('SELECT * FROM materials WHERE id = ?', id);
    if (!m) throw new HttpError(404, 'Material not found.');
    const withPrices = userCan(req, 'materials.prices');
    const price = withPrices ? currentPriceRows(db, [id]).get(id) : null;
    const out: any = { ...publicMaterial(m, price, withPrices), usedBy: userCan(req, 'recipes.read') ? productsUsingMaterial(db, id) : [] };
    if (withPrices) {
      out.priceHistory = db.all(`SELECT p.*, u.name AS created_by_name FROM material_prices p LEFT JOIN users u ON u.id = p.created_by WHERE material_id = ? ORDER BY undated, effective_date DESC, id DESC`, id);
    }
    return out;
  });

  app.post('/api/materials', async (req) => {
    const me = requirePerm(req, 'materials.write');
    const b = materialBody.parse(req.body);
    const id = db.run(
      `INSERT INTO materials (code, name, category, supplier, supplier_code, base_unit, density_kg_per_l, purity_pct, allergen_info, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?)`, b.code, b.name, b.category, b.supplier, b.supplierCode, b.baseUnit, b.densityKgPerL, b.purityPct, b.allergenInfo, b.notes,
    ).lastInsertRowid;
    audit(db, me, 'material', id, 'create', `Created material ${b.code} ${b.name}`, undefined, b);
    return { id };
  });

  app.patch('/api/materials/:id', async (req) => {
    const me = requirePerm(req, 'materials.write');
    const id = Number((req.params as any).id);
    const before = db.get<any>('SELECT * FROM materials WHERE id = ?', id);
    if (!before) throw new HttpError(404, 'Material not found.');
    const b = materialBody.parse(req.body);
    if (b.baseUnit !== before.base_unit && db.get('SELECT id FROM material_prices WHERE material_id = ?', id)) {
      throw new HttpError(409, 'The base unit cannot change once prices exist (existing prices are per the old unit). Create a new material instead.');
    }
    db.run(
      `UPDATE materials SET code=?, name=?, category=?, supplier=?, supplier_code=?, base_unit=?, density_kg_per_l=?, purity_pct=?, allergen_info=?, notes=?, updated_at=datetime('now') WHERE id=?`,
      b.code, b.name, b.category, b.supplier, b.supplierCode, b.baseUnit, b.densityKgPerL, b.purityPct, b.allergenInfo, b.notes, id,
    );
    audit(db, me, 'material', id, 'update', `Updated material ${b.code}`, before, b);
    return { ok: true };
  });

  app.post('/api/materials/:id/duplicate', async (req) => {
    const me = requirePerm(req, 'materials.write');
    const id = Number((req.params as any).id);
    const m = db.get<any>('SELECT * FROM materials WHERE id = ?', id);
    if (!m) throw new HttpError(404, 'Material not found.');
    let code = `${m.code}-copy`;
    for (let i = 2; db.get('SELECT id FROM materials WHERE code = ?', code); i++) code = `${m.code}-copy${i}`;
    const newId = db.run(
      `INSERT INTO materials (code, name, category, supplier, supplier_code, base_unit, density_kg_per_l, purity_pct, allergen_info, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?)`, code, `${m.name} (copy)`, m.category, m.supplier, m.supplier_code, m.base_unit, m.density_kg_per_l, m.purity_pct, m.allergen_info, m.notes,
    ).lastInsertRowid;
    audit(db, me, 'material', newId, 'create', `Duplicated material ${m.code} as ${code} (prices not copied)`);
    return { id: newId };
  });

  app.post('/api/materials/:id/archive', async (req) => {
    const me = requirePerm(req, 'materials.write');
    const id = Number((req.params as any).id);
    const { archived } = z.object({ archived: z.boolean() }).parse(req.body);
    db.run("UPDATE materials SET archived = ?, updated_at = datetime('now') WHERE id = ?", archived ? 1 : 0, id);
    audit(db, me, 'material', id, archived ? 'archive' : 'restore', archived ? 'Archived material' : 'Restored material');
    return { ok: true, usedBy: productsUsingMaterial(db, id) };
  });

  app.post('/api/materials/:id/review', async (req) => {
    const me = requirePerm(req, 'materials.write');
    const id = Number((req.params as any).id);
    const b = z.object({ status: z.enum(['ok', 'needs_review']), notes: z.string().max(2000).nullable().optional() }).parse(req.body);
    if (!db.get('SELECT id FROM materials WHERE id = ?', id)) throw new HttpError(404, 'Material not found.');
    db.run("UPDATE materials SET review_status = ?, review_notes = COALESCE(?, review_notes), updated_at = datetime('now') WHERE id = ?", b.status, b.notes, id);
    audit(db, me, 'material', id, 'review', `Review status set to ${b.status}`);
    return { ok: true };
  });

  function computeLanded(materialId: number, b: z.infer<typeof priceBody>) {
    const m = db.get<any>('SELECT * FROM materials WHERE id = ?', materialId);
    if (!m) throw new HttpError(404, 'Material not found.');
    const r = landedUnitPrice({ ...b, packUnit: b.packUnit ?? null, exchangeRate: b.exchangeRate ?? null }, m.base_unit, m.density_kg_per_l);
    if (!r.ok) throw new HttpError(400, r.error);
    return { m, landed: r.landed, formula: r.formula };
  }

  /** Impact of a (proposed) material price on current estimates and approved prices. */
  function impact(materialId: number, newLanded: string | null) {
    const used = productsUsingMaterial(db, materialId);
    const productIds = [...new Set(used.map((u) => u.product_id))];
    return productIds.map((pid) => {
      const v = currentVersion(db, pid);
      const product = db.get<any>('SELECT * FROM products WHERE id = ?', pid);
      if (!v) return { productId: pid, productName: product.name, note: 'No active recipe version' };
      const approved = db.all<any>("SELECT * FROM selling_prices WHERE product_id = ? AND status = 'approved' AND customer_id IS NULL ORDER BY id DESC", pid);
      const formatIds = approved.length ? [...new Set(approved.map((a) => a.packaging_format_id))] : [null];
      const rows = formatIds.map((fid) => {
        const before = runCosting(db, { recipeVersionId: v.id, packagingFormatId: fid });
        const after = newLanded !== null ? runCosting(db, { recipeVersionId: v.id, packagingFormatId: fid, priceOverrides: { [materialId]: newLanded } }) : before;
        const ap = approved.find((a) => a.packaging_format_id === fid);
        const unitBefore = fid ? before.result.costPerPackage : before.result.costPerOutputUnit;
        const unitAfter = fid ? after.result.costPerPackage : after.result.costPerOutputUnit;
        const mb = ap && unitBefore ? marginPct(ap.price, unitBefore) : null;
        const ma = ap && unitAfter ? marginPct(ap.price, unitAfter) : null;
        return {
          packagingFormatId: fid, unit: fid ? 'package' : product.output_unit, unitCostBefore: unitBefore, unitCostAfter: unitAfter,
          approvedPrice: ap?.price ?? null, marginBefore: mb?.ok ? mb.value : null, marginAfter: ma?.ok ? ma.value : null,
          targetMargin: product.target_margin_pct, completeBefore: before.result.complete, completeAfter: after.result.complete,
        };
      });
      return { productId: pid, productName: product.name, recipeVersion: v.version_no, rows };
    });
  }

  app.post('/api/materials/:id/prices/preview', async (req) => {
    requirePerm(req, 'materials.prices');
    const id = Number((req.params as any).id);
    const b = priceBody.parse(req.body);
    const { landed, formula } = computeLanded(id, b);
    return { landed, formula, impact: userCan(req, 'costs.read') ? impact(id, landed) : [] };
  });

  app.post('/api/materials/:id/prices', async (req) => {
    const me = requirePerm(req, 'materials.write', 'materials.prices');
    const id = Number((req.params as any).id);
    const b = priceBody.parse(req.body);
    const { m, landed, formula } = computeLanded(id, b);
    const before = currentPriceRows(db, [id]).get(id);
    const pid = db.run(
      `INSERT INTO material_prices (material_id, effective_date, entry_mode, pack_qty, pack_unit, price, currency, exchange_rate, rate_date, rate_source, charges_sek, landed_unit_price_sek, source, notes, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'manual', ?, ?)`,
      id, b.effectiveDate, b.entryMode, b.packQty, b.entryMode === 'per_pack' ? b.packUnit : null, b.price, b.currency,
      b.currency === 'SEK' ? '1' : b.exchangeRate, b.rateDate, b.rateSource, b.chargesSek ?? '0', landed, b.notes, me.id,
    ).lastInsertRowid;
    db.run("UPDATE materials SET updated_at = datetime('now') WHERE id = ?", id);
    audit(db, me, 'material', id, 'price', `New price for ${m.code}: ${formula} (effective ${b.effectiveDate})`, before ? { landed: before.landed_unit_price_sek, date: before.effective_date } : null, { landed, date: b.effectiveDate });
    return { id: pid, landed, formula, usedBy: productsUsingMaterial(db, id) };
  });

  app.get('/api/materials/:id/impact', async (req) => {
    requirePerm(req, 'costs.read');
    return impact(Number((req.params as any).id), null);
  });
}
