import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, requirePerm, userCan } from '../auth';
import type { DB } from '../db';
import { audit, currentVersion, runCosting } from '../services';
import { dec } from '../../shared/decimal';
import { COST_BASES, COST_CATEGORIES } from '../../shared/engine';

const num = (opt = true) => {
  const s = z.string().trim().refine((v) => v === '' || dec(v) !== null, 'must be a number').transform((v) => (v === '' ? null : v));
  return opt ? s.nullable().optional() : s;
};

const productBody = z.object({
  code: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  outputUnit: z.enum(['L', 'kg']),
  targetMarginPct: z.string().trim().nullable().optional().transform((v) => (v === '' || v == null ? null : v)).refine((v) => v === null || (dec(v) !== null && dec(v)!.gte(0) && dec(v)!.lt(100)), 'target margin must be a number from 0 to below 100'),
});

const versionBody = z.object({
  referenceBatchQty: num(),
  defaultBatchQty: num(),
  yieldMode: z.enum(['direct', 'stages']),
  yieldPct: num(),
  lossStages: z.array(z.object({ name: z.string().max(100), pct: z.string() })).max(20).default([]),
  instructions: z.string().max(20000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  ingredients: z.array(z.object({
    materialId: z.number().int().nullable(),
    quantity: num(),
    unit: z.enum(['g', 'kg', 'mL', 'L', 'pc']),
    note: z.string().max(500).nullable().optional(),
    needsReview: z.boolean().optional(),
  })).max(200),
  costItems: z.array(z.object({
    category: z.enum(Object.keys(COST_CATEGORIES) as [string, ...string[]]),
    description: z.string().max(200).default(''),
    basis: z.enum(Object.keys(COST_BASES) as [string, ...string[]]),
    rate: num(),
    hours: num(),
    hoursScale: z.boolean().optional(),
    stepSize: num(),
    percentBase: z.enum(['ingredients', 'conversion', 'production']).nullable().optional(),
    includesUtilities: z.boolean().optional(),
    needsReview: z.boolean().optional(),
    note: z.string().max(500).nullable().optional(),
  })).max(100),
});

const packagingBody = z.object({
  name: z.string().trim().min(1).max(200),
  fillQty: num(),
  fillUnit: z.enum(['g', 'kg', 'mL', 'L']),
  notes: z.string().max(2000).nullable().optional(),
  needsReview: z.boolean().optional(),
  components: z.array(z.object({ materialId: z.number().int().nullable(), qtyPerPackage: num() })).max(30),
});

function writeVersionContent(db: DB, vid: number, b: z.infer<typeof versionBody>) {
  db.run(
    `UPDATE recipe_versions SET reference_batch_qty=?, default_batch_qty=?, yield_mode=?, yield_pct=?, loss_stages_json=?, instructions=?, notes=?, updated_at=datetime('now') WHERE id=?`,
    b.referenceBatchQty, b.defaultBatchQty, b.yieldMode, b.yieldPct, JSON.stringify(b.lossStages), b.instructions, b.notes, vid,
  );
  db.run('DELETE FROM recipe_ingredients WHERE recipe_version_id = ?', vid);
  b.ingredients.forEach((i, n) => db.run('INSERT INTO recipe_ingredients (recipe_version_id, line_no, material_id, quantity, unit, note, needs_review) VALUES (?,?,?,?,?,?,?)', vid, n + 1, i.materialId, i.quantity, i.unit, i.note, i.needsReview && !i.quantity ? 1 : 0));
  db.run('DELETE FROM recipe_cost_items WHERE recipe_version_id = ?', vid);
  b.costItems.forEach((c, n) => db.run(
    'INSERT INTO recipe_cost_items (recipe_version_id, line_no, category, description, basis, rate, hours, hours_scale, step_size, percent_base, includes_utilities, needs_review, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    vid, n + 1, c.category, c.description, c.basis, c.rate, c.hours, c.hoursScale ?? false, c.stepSize, c.percentBase ?? null, c.includesUtilities ?? false, c.needsReview && !c.rate ? 1 : 0, c.note,
  ));
}

function copyVersion(db: DB, fromId: number, toProductId: number, versionNo: number, userId: number): number {
  const v = db.get<any>('SELECT * FROM recipe_versions WHERE id = ?', fromId);
  const nid = db.run(
    `INSERT INTO recipe_versions (product_id, version_no, status, reference_batch_qty, default_batch_qty, yield_mode, yield_pct, loss_stages_json, instructions, notes, review_status, review_notes, based_on_version_id, created_by)
     VALUES (?,?, 'draft', ?,?,?,?,?,?,?,?,?,?,?)`,
    toProductId, versionNo, v.reference_batch_qty, v.default_batch_qty, v.yield_mode, v.yield_pct, v.loss_stages_json, v.instructions, v.notes,
    v.review_status, v.review_notes, fromId, userId,
  ).lastInsertRowid;
  db.run('INSERT INTO recipe_ingredients (recipe_version_id, line_no, material_id, quantity, unit, note, needs_review) SELECT ?, line_no, material_id, quantity, unit, note, needs_review FROM recipe_ingredients WHERE recipe_version_id = ?', nid, fromId);
  db.run('INSERT INTO recipe_cost_items (recipe_version_id, line_no, category, description, basis, rate, hours, hours_scale, step_size, percent_base, includes_utilities, needs_review, note) SELECT ?, line_no, category, description, basis, rate, hours, hours_scale, step_size, percent_base, includes_utilities, needs_review, note FROM recipe_cost_items WHERE recipe_version_id = ?', nid, fromId);
  return nid;
}

export function versionDto(db: DB, id: number, showCosts = true) {
  const v = db.get<any>('SELECT rv.*, p.name AS product_name, p.output_unit, u.name AS created_by_name, a.name AS approved_by_name FROM recipe_versions rv JOIN products p ON p.id = rv.product_id LEFT JOIN users u ON u.id = rv.created_by LEFT JOIN users a ON a.id = rv.approved_by WHERE rv.id = ?', id);
  if (!v) throw new HttpError(404, 'Recipe version not found.');
  const usage = db.get<any>(`SELECT (SELECT COUNT(*) FROM quotation_lines WHERE recipe_version_id = ?) AS quotes, (SELECT COUNT(*) FROM production_batches WHERE recipe_version_id = ?) AS batches, (SELECT COUNT(*) FROM costings WHERE recipe_version_id = ?) AS costings`, id, id, id);
  return {
    id: v.id, productId: v.product_id, productName: v.product_name, outputUnit: v.output_unit, versionNo: v.version_no, status: v.status,
    referenceBatchQty: v.reference_batch_qty, defaultBatchQty: v.default_batch_qty, yieldMode: v.yield_mode, yieldPct: v.yield_pct,
    lossStages: JSON.parse(v.loss_stages_json || '[]'), instructions: v.instructions, notes: v.notes, reviewStatus: v.review_status,
    reviewNotes: showCosts ? v.review_notes : v.review_notes ? 'Items need review by production.' : null, basedOnVersionId: v.based_on_version_id, createdAt: v.created_at, createdByName: v.created_by_name,
    updatedAt: v.updated_at, approvedAt: v.approved_at, approvedByName: v.approved_by_name,
    importOriginal: showCosts && v.import_original_json ? JSON.parse(v.import_original_json) : null, usage,
    ingredients: db.all<any>('SELECT ri.*, m.name AS material_name, m.code AS material_code FROM recipe_ingredients ri LEFT JOIN materials m ON m.id = ri.material_id WHERE recipe_version_id = ? ORDER BY line_no', id)
      .map((i) => ({ id: i.id, materialId: i.material_id, materialName: i.material_name, quantity: i.quantity, unit: i.unit, note: showCosts || !/SEK/.test(i.note ?? '') ? i.note : null, needsReview: !!i.needs_review })),
    costItems: db.all<any>('SELECT * FROM recipe_cost_items WHERE recipe_version_id = ? ORDER BY line_no', id).map((c) => ({
      id: c.id, category: c.category, description: c.description, basis: c.basis, rate: showCosts ? c.rate : null, hours: c.hours, hoursScale: !!c.hours_scale,
      stepSize: c.step_size, percentBase: c.percent_base, includesUtilities: !!c.includes_utilities, needsReview: !!c.needs_review, note: showCosts ? c.note : null,
    })),
  };
}

export function packagingDto(db: DB, productId: number, includeArchived = false) {
  return db.all<any>(`SELECT * FROM packaging_formats WHERE product_id = ? ${includeArchived ? '' : 'AND archived = 0'} ORDER BY id`, productId).map((f) => ({
    id: f.id, name: f.name, fillQty: f.fill_qty, fillUnit: f.fill_unit, needsReview: !!f.needs_review, notes: f.notes, archived: !!f.archived,
    components: db.all<any>('SELECT pc.*, m.name AS material_name FROM packaging_components pc LEFT JOIN materials m ON m.id = pc.material_id WHERE format_id = ? ORDER BY pc.id', f.id)
      .map((c) => ({ materialId: c.material_id, materialName: c.material_name, qtyPerPackage: c.qty_per_package })),
  }));
}

export function registerRecipeRoutes(app: FastifyInstance) {
  const db = app.db;

  /** Product list. Sales sees products + approved prices only; costs require costs.read. */
  app.get('/api/products', async (req) => {
    const user = requirePerm(req);
    if (!userCan(req, 'recipes.read') && !userCan(req, 'prices.read')) throw new HttpError(403, 'Not allowed.');
    const q = req.query as any;
    const products = db.all<any>(`SELECT * FROM products ${q.archived === '1' ? '' : 'WHERE archived = 0'} ORDER BY name`);
    const showCosts = userCan(req, 'costs.read');
    return products.map((p) => {
      const v = currentVersion(db, p.id);
      const base: any = {
        id: p.id, code: p.code, name: p.name, description: p.description, outputUnit: p.output_unit, archived: !!p.archived,
        packagingFormats: packagingDto(db, p.id).map((f) => ({ id: f.id, name: f.name, fillQty: f.fillQty, fillUnit: f.fillUnit, needsReview: f.needsReview })),
        currentVersion: v ? { id: v.id, versionNo: v.version_no, status: v.status, reviewStatus: v.review_status } : null,
      };
      if (userCan(req, 'recipes.read')) {
        base.versionCount = db.get<any>('SELECT COUNT(*) AS n FROM recipe_versions WHERE product_id = ?', p.id).n;
      }
      if (showCosts) {
        base.targetMarginPct = p.target_margin_pct;
        if (v) {
          const c = runCosting(db, { recipeVersionId: v.id });
          base.estimate = { costPerOutputUnit: c.result.costPerOutputUnit, totalBatchCost: c.result.totalBatchCost, batchQty: c.result.batchQty, complete: c.result.complete, sections: c.result.sections, warnings: c.result.warnings.length };
        }
      }
      void user;
      return base;
    });
  });

  app.post('/api/products', async (req) => {
    const me = requirePerm(req, 'recipes.write');
    const b = productBody.parse(req.body);
    const out = db.tx(() => {
      const pid = db.run('INSERT INTO products (code, name, description, output_unit, target_margin_pct) VALUES (?,?,?,?,?)', b.code, b.name, b.description, b.outputUnit, b.targetMarginPct).lastInsertRowid;
      const vid = db.run("INSERT INTO recipe_versions (product_id, version_no, status, reference_batch_qty, default_batch_qty, yield_mode, yield_pct, created_by) VALUES (?, 1, 'draft', '100', '100', 'direct', '100', ?)", pid, me.id).lastInsertRowid;
      audit(db, me, 'product', pid, 'create', `Created product ${b.code} ${b.name} with draft v1`, undefined, b);
      return { id: pid, recipeVersionId: vid };
    });
    return out;
  });

  app.get('/api/products/:id', async (req) => {
    requirePerm(req, 'recipes.read');
    const id = Number((req.params as any).id);
    const p = db.get<any>('SELECT * FROM products WHERE id = ?', id);
    if (!p) throw new HttpError(404, 'Product not found.');
    return {
      id: p.id, code: p.code, name: p.name, description: p.description, outputUnit: p.output_unit, archived: !!p.archived,
      targetMarginPct: userCan(req, 'costs.read') ? p.target_margin_pct : undefined,
      versions: db.all<any>('SELECT rv.id, rv.version_no, rv.status, rv.review_status, rv.created_at, rv.approved_at, u.name AS created_by_name FROM recipe_versions rv LEFT JOIN users u ON u.id = rv.created_by WHERE product_id = ? ORDER BY version_no DESC', id)
        .map((v) => ({ id: v.id, versionNo: v.version_no, status: v.status, reviewStatus: v.review_status, createdAt: v.created_at, approvedAt: v.approved_at, createdByName: v.created_by_name })),
      currentVersionId: currentVersion(db, id)?.id ?? null,
      packagingFormats: packagingDto(db, id, true),
      qualitySpecs: db.all('SELECT * FROM quality_specs WHERE product_id = ? ORDER BY id', id),
    };
  });

  app.patch('/api/products/:id', async (req) => {
    const me = requirePerm(req, 'recipes.write');
    const id = Number((req.params as any).id);
    const before = db.get<any>('SELECT * FROM products WHERE id = ?', id);
    if (!before) throw new HttpError(404, 'Product not found.');
    const b = productBody.parse(req.body);
    if (b.outputUnit !== before.output_unit) {
      const used = db.get<any>(`SELECT (SELECT COUNT(*) FROM recipe_versions WHERE product_id = ? AND status != 'draft') + (SELECT COUNT(*) FROM selling_prices WHERE product_id = ?)
        + (SELECT COUNT(*) FROM quotation_lines WHERE product_id = ?) + (SELECT COUNT(*) FROM production_batches WHERE product_id = ?) + (SELECT COUNT(*) FROM costings WHERE product_id = ?) AS n`, id, id, id, id, id).n;
      if (used) throw new HttpError(409, 'The sales unit (L/kg) cannot change after recipes are approved or costings, prices, quotations or batches exist. Create a new product instead.');
    }
    db.run("UPDATE products SET code=?, name=?, description=?, output_unit=?, target_margin_pct=?, updated_at=datetime('now') WHERE id=?", b.code, b.name, b.description, b.outputUnit, b.targetMarginPct, id);
    audit(db, me, 'product', id, 'update', `Updated product ${b.name}`, before, b);
    return { ok: true };
  });

  app.post('/api/products/:id/archive', async (req) => {
    const me = requirePerm(req, 'recipes.write');
    const id = Number((req.params as any).id);
    const { archived } = z.object({ archived: z.boolean() }).parse(req.body);
    db.run("UPDATE products SET archived = ?, updated_at = datetime('now') WHERE id = ?", archived ? 1 : 0, id);
    audit(db, me, 'product', id, archived ? 'archive' : 'restore', archived ? 'Archived product and its recipes' : 'Restored product');
    return { ok: true };
  });

  app.post('/api/products/:id/duplicate', async (req) => {
    const me = requirePerm(req, 'recipes.write');
    const id = Number((req.params as any).id);
    const p = db.get<any>('SELECT * FROM products WHERE id = ?', id);
    if (!p) throw new HttpError(404, 'Product not found.');
    const v = currentVersion(db, id);
    return db.tx(() => {
      let code = `${p.code}-copy`;
      for (let i = 2; db.get('SELECT id FROM products WHERE code = ?', code); i++) code = `${p.code}-copy${i}`;
      const pid = db.run('INSERT INTO products (code, name, description, output_unit, target_margin_pct) VALUES (?,?,?,?,?)', code, `${p.name} (copy)`, p.description, p.output_unit, p.target_margin_pct).lastInsertRowid;
      const vid = v ? copyVersion(db, v.id, pid, 1, me.id) : null;
      for (const f of packagingDto(db, id)) {
        const fid = db.run('INSERT INTO packaging_formats (product_id, name, fill_qty, fill_unit, needs_review, notes) VALUES (?,?,?,?,?,?)', pid, f.name, f.fillQty, f.fillUnit, f.needsReview ? 1 : 0, f.notes).lastInsertRowid;
        for (const c of f.components) db.run('INSERT INTO packaging_components (format_id, material_id, qty_per_package) VALUES (?,?,?)', fid, c.materialId, c.qtyPerPackage);
      }
      audit(db, me, 'product', pid, 'create', `Duplicated ${p.name} as ${code}`);
      return { id: pid, recipeVersionId: vid };
    });
  });

  app.get('/api/recipe-versions/:id', async (req) => {
    requirePerm(req, 'recipes.read');
    return versionDto(db, Number((req.params as any).id), userCan(req, 'costs.read'));
  });

  app.put('/api/recipe-versions/:id', async (req) => {
    const me = requirePerm(req, 'recipes.write');
    const id = Number((req.params as any).id);
    const v = db.get<any>('SELECT * FROM recipe_versions WHERE id = ?', id);
    if (!v) throw new HttpError(404, 'Recipe version not found.');
    if (v.status !== 'draft') throw new HttpError(409, `Version ${v.version_no} is ${v.status} and cannot be edited. Create a new version to make changes.`);
    const b = versionBody.parse(req.body);
    for (const i of b.ingredients) if (i.materialId && !db.get('SELECT id FROM materials WHERE id = ?', i.materialId)) throw new HttpError(400, `Material ${i.materialId} does not exist.`);
    const before = versionDto(db, id);
    db.tx(() => writeVersionContent(db, id, b));
    audit(db, me, 'recipe_version', id, 'update', `Saved draft ${v.version_no}`, { ingredients: before.ingredients, costItems: before.costItems, yieldPct: before.yieldPct, referenceBatchQty: before.referenceBatchQty }, b);
    return versionDto(db, id);
  });

  app.post('/api/recipe-versions/:id/new-version', async (req) => {
    const me = requirePerm(req, 'recipes.write');
    const id = Number((req.params as any).id);
    const v = db.get<any>('SELECT * FROM recipe_versions WHERE id = ?', id);
    if (!v) throw new HttpError(404, 'Recipe version not found.');
    const nid = db.tx(() => {
      const n = db.get<any>('SELECT MAX(version_no) AS n FROM recipe_versions WHERE product_id = ?', v.product_id).n + 1;
      return copyVersion(db, id, v.product_id, n, me.id);
    });
    audit(db, me, 'recipe_version', nid, 'create', `Created new draft version from v${v.version_no}`);
    return { id: nid };
  });

  app.post('/api/recipe-versions/:id/approve', async (req) => {
    const me = requirePerm(req, 'recipes.approve');
    const id = Number((req.params as any).id);
    const v = db.get<any>('SELECT * FROM recipe_versions WHERE id = ?', id);
    if (!v) throw new HttpError(404, 'Recipe version not found.');
    if (v.status !== 'draft') throw new HttpError(409, 'Only draft versions can be approved.');
    if (v.review_status === 'needs_review') throw new HttpError(409, 'Resolve the "Needs review" items and mark the version as reviewed before approving.');
    const c = runCosting(db, { recipeVersionId: id });
    if (!c.result.complete) {
      const reasons = [...c.result.warnings.filter((w) => w.level !== 'info').map((w) => w.message), ...c.result.lines.filter((l) => l.status !== 'ok' && l.section === 'ingredients').map((l) => `${l.label}: ${l.message ?? l.formula}`)];
      throw new HttpError(409, `Cannot approve an incomplete recipe: ${[...new Set(reasons)].join(' ')}`);
    }
    db.tx(() => {
      db.run("UPDATE recipe_versions SET status = 'archived', updated_at = datetime('now') WHERE product_id = ? AND status = 'approved'", v.product_id);
      db.run("UPDATE recipe_versions SET status = 'approved', approved_by = ?, approved_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", me.id, id);
    });
    audit(db, me, 'recipe_version', id, 'approve', `Approved v${v.version_no} (previous approved version archived, kept for history)`);
    return { ok: true };
  });

  app.post('/api/recipe-versions/:id/archive', async (req) => {
    const me = requirePerm(req, 'recipes.write');
    const id = Number((req.params as any).id);
    const v = db.get<any>('SELECT * FROM recipe_versions WHERE id = ?', id);
    if (!v) throw new HttpError(404, 'Recipe version not found.');
    if (v.status === 'approved') requirePerm(req, 'recipes.approve');
    db.run("UPDATE recipe_versions SET status = 'archived', updated_at = datetime('now') WHERE id = ?", id);
    audit(db, me, 'recipe_version', id, 'archive', 'Archived recipe version');
    return { ok: true };
  });

  app.post('/api/recipe-versions/:id/review', async (req) => {
    const me = requirePerm(req, 'recipes.write');
    const id = Number((req.params as any).id);
    const b = z.object({ status: z.enum(['ok', 'needs_review']), notes: z.string().max(5000).nullable().optional() }).parse(req.body);
    const v = db.get<any>('SELECT * FROM recipe_versions WHERE id = ?', id);
    if (!v) throw new HttpError(404, 'Recipe version not found.');
    if (v.status !== 'draft') throw new HttpError(409, 'Review status can only change on drafts.');
    db.run("UPDATE recipe_versions SET review_status = ?, review_notes = ?, updated_at = datetime('now') WHERE id = ?", b.status, b.notes ?? v.review_notes, id);
    if (b.status === 'ok') {
      db.run('UPDATE recipe_ingredients SET needs_review = 0 WHERE recipe_version_id = ? AND quantity IS NOT NULL', id);
      db.run('UPDATE recipe_cost_items SET needs_review = 0 WHERE recipe_version_id = ? AND rate IS NOT NULL', id);
    }
    audit(db, me, 'recipe_version', id, 'review', `Marked v${v.version_no} as ${b.status === 'ok' ? 'reviewed' : 'needs review'}`);
    return { ok: true };
  });

  // Packaging formats (product-level; snapshots preserve what was used historically)
  app.post('/api/products/:id/packaging', async (req) => {
    const me = requirePerm(req, 'recipes.write');
    const pid = Number((req.params as any).id);
    const b = packagingBody.parse(req.body);
    const fid = db.tx(() => {
      const fid = db.run('INSERT INTO packaging_formats (product_id, name, fill_qty, fill_unit, notes, needs_review) VALUES (?,?,?,?,?,?)', pid, b.name, b.fillQty, b.fillUnit, b.notes, b.needsReview ? 1 : 0).lastInsertRowid;
      for (const c of b.components) db.run('INSERT INTO packaging_components (format_id, material_id, qty_per_package) VALUES (?,?,?)', fid, c.materialId, c.qtyPerPackage);
      return fid;
    });
    audit(db, me, 'packaging_format', fid, 'create', `Added packaging format ${b.name}`, undefined, b);
    return { id: fid };
  });

  app.put('/api/packaging/:id', async (req) => {
    const me = requirePerm(req, 'recipes.write');
    const id = Number((req.params as any).id);
    const before = db.get<any>('SELECT * FROM packaging_formats WHERE id = ?', id);
    if (!before) throw new HttpError(404, 'Packaging format not found.');
    const b = packagingBody.parse(req.body);
    const used = db.get<any>(`SELECT (SELECT COUNT(*) FROM selling_prices WHERE packaging_format_id = ? AND status IN ('approved','proposed'))
      + (SELECT COUNT(*) FROM quotation_lines WHERE packaging_format_id = ?) + (SELECT COUNT(*) FROM production_batches WHERE packaging_format_id = ?) AS n`, id, id, id).n;
    const fillChanged = !(dec(b.fillQty)?.eq(dec(before.fill_qty) ?? -1)) || b.fillUnit !== before.fill_unit;
    if (used && fillChanged) throw new HttpError(409, 'This format is used by selling prices, quotations or batches, so its fill volume is locked (prices are per volume). Add a new format for a different volume. Packaging components can still be changed; saved prices and quotations keep their own snapshot.');
    db.tx(() => {
      db.run('UPDATE packaging_formats SET name=?, fill_qty=?, fill_unit=?, notes=?, needs_review=? WHERE id=?', b.name, b.fillQty, b.fillUnit, b.notes, b.needsReview ? 1 : 0, id);
      db.run('DELETE FROM packaging_components WHERE format_id = ?', id);
      for (const c of b.components) db.run('INSERT INTO packaging_components (format_id, material_id, qty_per_package) VALUES (?,?,?)', id, c.materialId, c.qtyPerPackage);
    });
    audit(db, me, 'packaging_format', id, 'update', `Updated packaging format ${b.name}`, before, b);
    return { ok: true };
  });

  app.post('/api/packaging/:id/archive', async (req) => {
    const me = requirePerm(req, 'recipes.write');
    const id = Number((req.params as any).id);
    const { archived } = z.object({ archived: z.boolean() }).parse(req.body);
    db.run('UPDATE packaging_formats SET archived = ? WHERE id = ?', archived ? 1 : 0, id);
    audit(db, me, 'packaging_format', id, archived ? 'archive' : 'restore', 'Packaging format archive state changed');
    return { ok: true };
  });

  // Quality specifications (configurable; no built-in limits)
  const specBody = z.object({ parameter: z.string().trim().min(1).max(100), unit: z.string().max(30).nullable().optional(), minValue: num(), maxValue: num(), targetText: z.string().max(500).nullable().optional(), method: z.string().max(200).nullable().optional(), active: z.boolean().default(true) });
  app.post('/api/products/:id/quality-specs', async (req) => {
    const me = requirePerm(req, 'quality.write');
    const pid = Number((req.params as any).id);
    const b = specBody.parse(req.body);
    const id = db.run('INSERT INTO quality_specs (product_id, parameter, unit, min_value, max_value, target_text, method, active) VALUES (?,?,?,?,?,?,?,?)', pid, b.parameter, b.unit, b.minValue, b.maxValue, b.targetText, b.method, b.active).lastInsertRowid;
    audit(db, me, 'quality_spec', id, 'create', `Added quality spec ${b.parameter}`, undefined, b);
    return { id };
  });
  app.put('/api/quality-specs/:id', async (req) => {
    const me = requirePerm(req, 'quality.write');
    const id = Number((req.params as any).id);
    const b = specBody.parse(req.body);
    const before = db.get('SELECT * FROM quality_specs WHERE id = ?', id);
    if (!before) throw new HttpError(404, 'Specification not found.');
    db.run('UPDATE quality_specs SET parameter=?, unit=?, min_value=?, max_value=?, target_text=?, method=?, active=? WHERE id=?', b.parameter, b.unit, b.minValue, b.maxValue, b.targetText, b.method, b.active, id);
    audit(db, me, 'quality_spec', id, 'update', `Updated quality spec ${b.parameter}`, before, b);
    return { ok: true };
  });
}
