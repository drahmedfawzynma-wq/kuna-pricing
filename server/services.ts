import type { DB, Row } from './db';
import { today } from './db';
import type { SessionUser } from './auth';
import { HttpError } from './auth';
import {
  calculateCosting, type CostingInput, type CostingResult, type MaterialPrice, type PackagingFormat, type RecipeForCosting,
} from '../shared/engine';

export function audit(db: DB, user: SessionUser | undefined, entity: string, entityId: number | null, action: string, summary: string, before?: unknown, after?: unknown) {
  db.run(
    'INSERT INTO audit_log (user_id, user_name, entity, entity_id, action, summary, before_json, after_json) VALUES (?,?,?,?,?,?,?,?)',
    user?.id ?? null, user?.name ?? 'system', entity, entityId, action, summary,
    before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after),
  );
}

/** Current price row for each material: latest dated entry effective on or before today. */
export function currentPriceRows(db: DB, materialIds?: number[]): Map<number, Row> {
  const rows = db.all(
    `SELECT p.* FROM material_prices p
     WHERE p.undated = 0 AND p.effective_date <= ?
     ${materialIds ? `AND p.material_id IN (${materialIds.map(() => '?').join(',') || 'NULL'})` : ''}
     ORDER BY p.material_id, p.effective_date DESC, p.id DESC`,
    today(), ...(materialIds ?? []),
  );
  const m = new Map<number, Row>();
  for (const r of rows) if (!m.has(r.material_id)) m.set(r.material_id, r);
  return m;
}

export function materialsMap(db: DB, ids?: number[]): Record<number, MaterialPrice> {
  const mats = ids
    ? ids.length ? db.all(`SELECT * FROM materials WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids) : []
    : db.all('SELECT * FROM materials');
  const prices = currentPriceRows(db, ids);
  const out: Record<number, MaterialPrice> = {};
  for (const m of mats) {
    const p = prices.get(m.id);
    out[m.id] = {
      id: m.id, code: m.code, name: m.name, baseUnit: m.base_unit, densityKgPerL: m.density_kg_per_l,
      unitPriceSek: p ? p.landed_unit_price_sek : null, priceDate: p?.effective_date ?? null, priceId: p?.id ?? null,
      needsReview: m.review_status === 'needs_review',
    };
  }
  return out;
}

export function loadRecipeVersion(db: DB, versionId: number) {
  const v = db.get('SELECT rv.*, p.output_unit, p.name AS product_name, p.code AS product_code, p.target_margin_pct FROM recipe_versions rv JOIN products p ON p.id = rv.product_id WHERE rv.id = ?', versionId);
  if (!v) throw new HttpError(404, 'Recipe version not found.');
  const ingredients = db.all('SELECT * FROM recipe_ingredients WHERE recipe_version_id = ? ORDER BY line_no', versionId);
  const costItems = db.all('SELECT * FROM recipe_cost_items WHERE recipe_version_id = ? ORDER BY line_no', versionId);
  return { v, ingredients, costItems };
}

export function toRecipeForCosting(v: Row, ingredients: Row[], costItems: Row[]): RecipeForCosting {
  return {
    outputUnit: v.output_unit,
    referenceBatchQty: v.reference_batch_qty,
    yieldMode: v.yield_mode,
    yieldPct: v.yield_pct,
    lossStages: JSON.parse(v.loss_stages_json || '[]'),
    ingredients: ingredients.map((i) => ({ id: i.id, materialId: i.material_id, quantity: i.quantity, unit: i.unit, note: i.note })),
    costItems: costItems.map((c) => ({
      id: c.id, category: c.category, description: c.description, basis: c.basis, rate: c.rate, hours: c.hours,
      hoursScale: !!c.hours_scale, stepSize: c.step_size, percentBase: c.percent_base, includesUtilities: !!c.includes_utilities,
      needsReview: !!c.needs_review,
    })),
  };
}

export function loadPackaging(db: DB, formatId: number | null | undefined): PackagingFormat | null {
  if (!formatId) return null;
  const f = db.get('SELECT * FROM packaging_formats WHERE id = ?', formatId);
  if (!f) throw new HttpError(404, 'Packaging format not found.');
  const comps = db.all('SELECT * FROM packaging_components WHERE format_id = ? ORDER BY id', formatId);
  return {
    id: f.id, name: f.name, fillQty: f.fill_qty, fillUnit: f.fill_unit, needsReview: !!f.needs_review,
    components: comps.map((c) => ({ materialId: c.material_id, qtyPerPackage: c.qty_per_package })),
  };
}

export interface CostingRequest {
  recipeVersionId: number;
  batchQty?: string | null;
  yieldPctOverride?: string | null;
  packagingFormatId?: number | null;
  priceOverrides?: Record<number, string>;
  actualOutputQty?: string | null;
  actualPackagedUnits?: string | null;
  extraCosts?: CostingInput['extraCosts'];
  /** Use a recipe passed in (draft edits / scenario formulation) instead of the stored one. */
  recipeOverride?: RecipeForCosting;
}

export function runCosting(db: DB, req: CostingRequest): { input: CostingInput; result: CostingResult; version: Row } {
  const { v, ingredients, costItems } = loadRecipeVersion(db, req.recipeVersionId);
  const recipe = req.recipeOverride ? { ...req.recipeOverride, outputUnit: v.output_unit } : toRecipeForCosting(v, ingredients, costItems);
  const packaging = loadPackaging(db, req.packagingFormatId);
  const ids = new Set<number>();
  recipe.ingredients.forEach((i) => i.materialId && ids.add(i.materialId));
  packaging?.components.forEach((c) => c.materialId && ids.add(c.materialId));
  const input: CostingInput = {
    recipe,
    batchQty: req.batchQty || v.default_batch_qty || v.reference_batch_qty,
    yieldPctOverride: req.yieldPctOverride ?? null,
    packaging,
    materials: materialsMap(db, [...ids]),
    priceOverrides: req.priceOverrides,
    actualOutputQty: req.actualOutputQty ?? null,
    actualPackagedUnits: req.actualPackagedUnits ?? null,
    extraCosts: req.extraCosts?.length ? req.extraCosts : undefined,
  };
  if (v.review_status === 'needs_review') {
    // Surface but do not block: imported records remain usable while under review.
  }
  const result = calculateCosting(input);
  if (v.review_status === 'needs_review') {
    result.warnings.unshift({ level: 'warning', code: 'recipe_review', message: `Recipe ${v.product_name} v${v.version_no} is marked "Needs review".` });
  }
  return { input, result, version: v };
}

/** Persist an immutable snapshot. */
export function saveCosting(db: DB, user: SessionUser | undefined, kind: string, name: string | null, input: CostingInput, result: CostingResult, version: Row, packagingFormatId?: number | null, notes?: string | null): number {
  const r = db.run(
    `INSERT INTO costings (kind, name, product_id, recipe_version_id, packaging_format_id, inputs_json, result_json, complete,
      total_batch_cost, cost_per_output_unit, cost_per_package, notes, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    kind, name, version.product_id, version.id, packagingFormatId ?? null,
    JSON.stringify({ ...input, recipeVersion: { id: version.id, versionNo: version.version_no, status: version.status, productName: version.product_name } }),
    JSON.stringify(result), result.complete ? 1 : 0, result.totalBatchCost, result.costPerOutputUnit, result.costPerPackage, notes ?? null, user?.id ?? null,
  );
  audit(db, user, 'costing', r.lastInsertRowid, 'create', `Saved ${kind} costing${name ? ` "${name}"` : ''} for ${version.product_name} v${version.version_no}`);
  return r.lastInsertRowid;
}

/** Products (recipe versions currently in use) that consume a material. */
export function productsUsingMaterial(db: DB, materialId: number): Row[] {
  return db.all(
    `SELECT DISTINCT p.id AS product_id, p.name AS product_name, rv.id AS recipe_version_id, rv.version_no, rv.status, 'ingredient' AS usage
       FROM recipe_ingredients ri JOIN recipe_versions rv ON rv.id = ri.recipe_version_id JOIN products p ON p.id = rv.product_id
      WHERE ri.material_id = ? AND rv.status != 'archived' AND p.archived = 0
     UNION
     SELECT DISTINCT p.id, p.name, NULL, NULL, NULL, 'packaging: ' || pf.name
       FROM packaging_components pc JOIN packaging_formats pf ON pf.id = pc.format_id JOIN products p ON p.id = pf.product_id
      WHERE pc.material_id = ? AND pf.archived = 0 AND p.archived = 0
     ORDER BY 2`, materialId, materialId);
}

/** The recipe version used for current estimates: latest approved, else latest draft. */
export function currentVersion(db: DB, productId: number): Row | undefined {
  return db.get(
    `SELECT * FROM recipe_versions WHERE product_id = ? AND status != 'archived'
     ORDER BY CASE status WHEN 'approved' THEN 0 ELSE 1 END, version_no DESC LIMIT 1`, productId);
}

export function getSetting(db: DB, key: string, fallback: string): string {
  return db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value ?? fallback;
}
