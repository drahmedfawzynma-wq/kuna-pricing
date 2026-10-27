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
  /** Price one unit of this volume filled into the standard container (Settings). Ignored when packagingFormatId is set. */
  sellVolume?: SellVolume | null;
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
  const packaging = req.packagingFormatId ? loadPackaging(db, req.packagingFormatId) : req.sellVolume ? standardContainerPackaging(db, req.sellVolume).packaging : null;
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

export interface SellVolume { qty: string; unit: 'mL' | 'L' | 'g' | 'kg' }

export function volumeLabel(v: SellVolume) {
  return `${v.qty.replace('.', ',')} ${v.unit}`;
}

/** The standard container (Settings) as packaging components: material codes, 1 of each per unit; "2 x code" for more. */
export function standardContainerItems(db: DB): { components: { materialId: number; qtyPerPackage: string }[]; missing: string[]; name: string } {
  const name = getSetting(db, 'standard_container_name', 'standard container');
  const raw = getSetting(db, 'standard_container_items', '');
  const components: { materialId: number; qtyPerPackage: string }[] = [];
  const missing: string[] = [];
  for (const part of raw.split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = /^(\d+(?:\.\d+)?)\s*[x×]\s*(.+)$/i.exec(part);
    const code = (m ? m[2] : part).trim();
    const mat = db.get<Row>('SELECT id FROM materials WHERE code = ? AND archived = 0', code);
    if (!mat) missing.push(code);
    else components.push({ materialId: mat.id, qtyPerPackage: m ? m[1] : '1' });
  }
  return { components, missing, name };
}

export function standardContainerPackaging(db: DB, v: SellVolume): { packaging: PackagingFormat; name: string; missing: string[] } {
  const c = standardContainerItems(db);
  const name = `${volumeLabel(v)} in ${c.name}`;
  return { name, missing: c.missing, packaging: { name, fillQty: v.qty, fillUnit: v.unit, components: c.components } };
}

/** Reuse the product's format for this volume in the standard container, or create it. */
export function findOrCreateVolumeFormat(db: DB, user: SessionUser | undefined, productId: number, v: SellVolume): number {
  const { packaging, name, missing } = standardContainerPackaging(db, v);
  if (missing.length) throw new HttpError(400, `Standard container items not found in Materials: ${missing.join(', ')}. Check Settings → Standard container.`);
  const want = JSON.stringify(packaging.components.map((c) => [c.materialId, c.qtyPerPackage]).sort());
  const candidates = db.all<Row>('SELECT * FROM packaging_formats WHERE product_id = ? AND archived = 0 AND fill_qty = ? AND fill_unit = ?', productId, v.qty, v.unit);
  for (const f of candidates) {
    const have = JSON.stringify(db.all<Row>('SELECT material_id, qty_per_package FROM packaging_components WHERE format_id = ?', f.id).map((c) => [c.material_id, c.qty_per_package]).sort());
    if (have === want) return f.id;
  }
  const fid = db.run('INSERT INTO packaging_formats (product_id, name, fill_qty, fill_unit, notes) VALUES (?,?,?,?,?)', productId, name, v.qty, v.unit, 'Created from a sales volume in the price calculator.').lastInsertRowid;
  for (const c of packaging.components) db.run('INSERT INTO packaging_components (format_id, material_id, qty_per_package) VALUES (?,?,?)', fid, c.materialId, c.qtyPerPackage);
  audit(db, user, 'packaging_format', fid, 'create', `Created format "${name}" for a sales volume`);
  return fid;
}
