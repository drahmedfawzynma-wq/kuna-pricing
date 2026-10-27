import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, requirePerm } from '../auth';
import type { DB, Row } from '../db';
import { today } from '../db';
import { audit } from '../services';
import { parseCsv, rowsToObjects } from '../csv';
import {
  analyzeBatchworksCosting, analyzeBatchworksMaterials, detectFormat, isQtyUnit, type CostingAnalysis, type CostingDecisions, type MaterialProposal,
} from '../importers';
import { landedUnitPrice } from '../../shared/materialPrice';
import { dec } from '../../shared/decimal';
import type { SessionUser } from '../auth';

function analyze(db: DB, kind: string, text: string, pendingNames: string[]) {
  if (kind === 'batchworks_materials') return analyzeBatchworksMaterials(db, text);
  if (kind === 'batchworks_costing') return analyzeBatchworksCosting(db, text, pendingNames);
  if (kind === 'materials_csv') return analyzeNativeMaterials(db, text);
  throw new HttpError(400, 'Unrecognised file. Supported: Batchworks materials export, Batchworks costing export, Kuna materials CSV.');
}

/** Kuna's own materials CSV (same columns as the export). */
function analyzeNativeMaterials(db: DB, text: string) {
  const { header, records } = rowsToObjects(parseCsv(text));
  const fileIssues: any[] = [];
  for (const c of ['code', 'name', 'category', 'base_unit']) if (!header.includes(c)) fileIssues.push({ level: 'error', message: `Missing column "${c}".` });
  const proposals = records.map((o, i) => {
    const issues: any[] = [];
    if (!o.code) issues.push({ level: 'error', field: 'code', message: 'Code is required.' });
    if (!o.name) issues.push({ level: 'error', field: 'name', message: 'Name is required.' });
    if (!['kg', 'L', 'pc'].includes(o.base_unit)) issues.push({ level: 'error', field: 'base_unit', message: 'base_unit must be kg, L or pc.' });
    if (!['raw', 'water', 'processing_aid', 'consumable', 'packaging'].includes(o.category)) issues.push({ level: 'error', field: 'category', message: 'Unknown category.' });
    if (o.density_kg_per_l && !dec(o.density_kg_per_l)) issues.push({ level: 'error', field: 'density_kg_per_l', message: 'Density must be a number.' });
    let price: any = null;
    if (o.price) {
      const mode = o.entry_mode === 'per_pack' ? 'per_pack' : 'per_unit';
      const r = landedUnitPrice({ entryMode: mode, packQty: o.pack_qty, packUnit: isQtyUnit(o.pack_unit) ? o.pack_unit : null, price: o.price, currency: (o.currency || 'SEK').toUpperCase(), exchangeRate: o.exchange_rate || null, chargesSek: o.charges_sek || '0' }, (o.base_unit as any) || 'kg', o.density_kg_per_l || null);
      if (!r.ok) issues.push({ level: 'error', field: 'price', message: r.error });
      else {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(o.effective_date || '')) issues.push({ level: 'error', field: 'effective_date', message: 'effective_date (YYYY-MM-DD) is required with a price.' });
        price = { entryMode: mode, packQty: o.pack_qty || null, packUnit: o.pack_unit || null, price: o.price, currency: (o.currency || 'SEK').toUpperCase(), exchangeRate: (o.currency || 'SEK').toUpperCase() === 'SEK' ? '1' : o.exchange_rate, rateDate: o.rate_date || null, chargesSek: o.charges_sek || '0', effectiveDate: o.effective_date, landed: r.landed, formula: r.formula };
      }
    }
    const existing = o.code ? db.get<Row>('SELECT id, landed_unit_price_sek FROM materials m LEFT JOIN material_prices p ON p.material_id = m.id WHERE m.code = ? ORDER BY p.effective_date DESC LIMIT 1', o.code) : undefined;
    const err = issues.some((x) => x.level === 'error');
    return {
      rowNo: i + 2, original: o, existingId: existing?.id ?? null,
      action: err ? 'skip' : existing ? 'update' : 'create',
      material: { code: o.code, name: o.name, category: o.category, supplier: o.supplier || null, supplierCode: o.supplier_code || null, baseUnit: o.base_unit, densityKgPerL: o.density_kg_per_l || null, notes: o.notes || null },
      price, issues, needsReview: false,
    };
  });
  return { proposals, fileIssues };
}

export function registerImportRoutes(app: FastifyInstance) {
  const db = app.db;

  app.post('/api/imports/preview', async (req) => {
    const me = requirePerm(req, 'imports.run');
    const b = z.object({ files: z.array(z.object({ filename: z.string().max(300), text: z.string().max(2_000_000) })).min(1).max(30) }).parse(req.body);
    // Materials first so costing files can see pending material names.
    const files = b.files.map((f) => ({ ...f, kind: detectFormat(f.text) }));
    const unknown = files.filter((f) => f.kind === 'unknown');
    if (unknown.length) throw new HttpError(400, `Unrecognised file format: ${unknown.map((u) => u.filename).join(', ')}`);
    files.sort((a, c) => (a.kind === 'batchworks_materials' ? -1 : 0) - (c.kind === 'batchworks_materials' ? -1 : 0));
    const pendingNames: string[] = [];
    const ids: number[] = [];
    for (const f of files) {
      let parsed: any;
      try {
        parsed = analyze(db, f.kind, f.text, pendingNames);
      } catch (e: any) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(400, `${f.filename}: ${e.message}`);
      }
      if (f.kind === 'batchworks_materials' || f.kind === 'materials_csv') pendingNames.push(...parsed.proposals.map((p: any) => p.material.name));
      const id = db.run('INSERT INTO import_batches (kind, filename, raw_text, parsed_json, created_by) VALUES (?,?,?,?,?)', f.kind, f.filename, f.text, JSON.stringify(parsed), me.id).lastInsertRowid;
      ids.push(id);
    }
    return { ids };
  });

  app.get('/api/imports', async (req) => {
    requirePerm(req, 'imports.run');
    return db.all('SELECT id, kind, filename, status, created_at, applied_at FROM import_batches ORDER BY id DESC LIMIT 200');
  });

  app.get('/api/imports/:id', async (req) => {
    requirePerm(req, 'imports.run');
    const r = db.get<any>('SELECT * FROM import_batches WHERE id = ?', Number((req.params as any).id));
    if (!r) throw new HttpError(404, 'Import not found.');
    let parsed = JSON.parse(r.parsed_json);
    // Re-analyse open costing previews so material matches reflect materials imported since.
    if (r.status === 'preview' && r.kind === 'batchworks_costing') parsed = analyzeBatchworksCosting(db, r.raw_text);
    return { id: r.id, kind: r.kind, filename: r.filename, status: r.status, createdAt: r.created_at, appliedAt: r.applied_at, parsed, decisions: r.decisions_json ? JSON.parse(r.decisions_json) : null, rawText: r.raw_text };
  });

  app.post('/api/imports/:id/discard', async (req) => {
    const me = requirePerm(req, 'imports.run');
    const id = Number((req.params as any).id);
    db.run("UPDATE import_batches SET status = 'discarded' WHERE id = ? AND status = 'preview'", id);
    audit(db, me, 'import', id, 'discard', 'Discarded import preview');
    return { ok: true };
  });

  app.post('/api/imports/:id/apply', async (req) => {
    const me = requirePerm(req, 'imports.run', 'materials.write');
    const id = Number((req.params as any).id);
    const r = db.get<any>('SELECT * FROM import_batches WHERE id = ?', id);
    if (!r) throw new HttpError(404, 'Import not found.');
    if (r.status !== 'preview') throw new HttpError(409, `This import is already ${r.status}.`);
    const body = (req.body ?? {}) as any;
    const result = db.tx(() => {
      let out: any;
      if (r.kind === 'batchworks_materials' || r.kind === 'materials_csv') {
        const parsed = analyze(db, r.kind, r.raw_text, []) as { proposals: any[] };
        const excluded = new Set<number>((body.excludeRows ?? []).map(Number));
        out = applyMaterials(db, me, id, parsed.proposals.filter((p) => !excluded.has(p.rowNo)), r.kind);
      } else if (r.kind === 'batchworks_costing') {
        requirePerm(req, 'recipes.write');
        const analysis = analyzeBatchworksCosting(db, r.raw_text);
        const d = validateDecisions({ ...analysis.proposed, ...(body.decisions ?? {}) });
        out = applyCosting(db, me, id, analysis, d);
      } else throw new HttpError(400, 'Unsupported import kind.');
      db.run("UPDATE import_batches SET status = 'applied', applied_at = datetime('now'), decisions_json = ? WHERE id = ?", JSON.stringify(body), id);
      audit(db, me, 'import', id, 'apply', `Applied import ${r.filename}: ${JSON.stringify(out.summary)}`);
      return out;
    });
    return result;
  });
}

export function validateDecisions(d: any): CostingDecisions {
  const schema = z.object({
    productCode: z.string().trim().min(1), productName: z.string().trim().min(1),
    referenceBatchQty: z.string().refine((s) => dec(s)?.gt(0), 'must be > 0'),
    defaultBatchQty: z.string().refine((s) => dec(s)?.gt(0), 'must be > 0'),
    yieldPct: z.string().refine((s) => { const v = dec(s); return !!v && v.gt(0) && v.lte(100); }, 'must be 0–100'),
    targetMarginPct: z.string().nullable().refine((s) => s === null || s === '' || (dec(s)?.gte(0) && dec(s)!.lt(100)), 'must be 0–99.99'),
    labourChoice: z.enum(['unresolved', 'fixed', 'rate_x_hours', 'swapped', 'exclude']),
    packagingName: z.string(), fillQty: z.string().nullable(), fillUnit: z.enum(['g', 'kg', 'mL', 'L', 'pc']),
    qtyPerPackage: z.string().nullable(), waterQty: z.string().nullable(), waterUnit: z.enum(['g', 'kg', 'mL', 'L']),
    confirmed: z.boolean(), materialMap: z.record(z.string(), z.union([z.number(), z.literal('create')])),
  });
  const v = schema.parse(d);
  if (v.waterQty !== null && v.waterQty !== '' && !dec(v.waterQty)) throw new HttpError(400, 'Water quantity must be a number.');
  return v as CostingDecisions;
}

export function applyMaterials(db: DB, me: SessionUser, importId: number, proposals: (MaterialProposal | any)[], kind: string) {
  let created = 0, priced = 0, skipped = 0, updated = 0;
  const source = kind === 'materials_csv' ? 'csv' : 'batchworks';
  for (const p of proposals) {
    if (p.action === 'skip') { skipped++; continue; }
    const issues = p.issues.filter((i: any) => i.level !== 'info').map((i: any) => `${i.field ? i.field + ': ' : ''}${i.message}`);
    const infos = p.issues.filter((i: any) => i.level === 'info').map((i: any) => i.message);
    let mid = db.get<Row>('SELECT id FROM materials WHERE code = ?', p.material.code)?.id as number | undefined;
    if (!mid) {
      mid = db.run(
        `INSERT INTO materials (code, name, category, supplier, supplier_code, base_unit, density_kg_per_l, purity_pct, notes, review_status, review_notes, import_batch_id, import_original_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        p.material.code, p.material.name, p.material.category, p.material.supplier, p.material.supplierCode ?? null, p.material.baseUnit,
        p.material.densityKgPerL ?? null, p.material.purityPct ?? null, p.material.notes || null,
        issues.length ? 'needs_review' : 'ok', issues.join('\n') || null, importId, JSON.stringify({ ...p.original, _importInfo: infos }),
      ).lastInsertRowid;
      created++;
      audit(db, me, 'material', mid, 'import', `Imported material ${p.material.code}`, undefined, p.original);
    } else if (kind === 'materials_csv') {
      db.run(`UPDATE materials SET name=?, category=?, supplier=?, supplier_code=?, density_kg_per_l=?, notes=COALESCE(?, notes), updated_at=datetime('now') WHERE id=?`,
        p.material.name, p.material.category, p.material.supplier, p.material.supplierCode, p.material.densityKgPerL, p.material.notes, mid);
      updated++;
    } else if (issues.length) {
      db.run("UPDATE materials SET review_status = 'needs_review', review_notes = ?, import_original_json = ? WHERE id = ?", issues.join('\n'), JSON.stringify(p.original), mid);
    }
    if (p.price) {
      const dup = db.get('SELECT id FROM material_prices WHERE material_id = ? AND effective_date = ? AND landed_unit_price_sek = ?', mid, p.price.effectiveDate, p.price.landed);
      if (!dup) {
        db.run(
          `INSERT INTO material_prices (material_id, effective_date, entry_mode, pack_qty, pack_unit, price, currency, exchange_rate, rate_date, rate_source, charges_sek, landed_unit_price_sek, source, notes, created_by)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          mid, p.price.effectiveDate, p.price.entryMode, p.price.packQty ?? null, p.price.entryMode === 'per_pack' ? p.price.packUnit : null, p.price.price, p.price.currency,
          p.price.exchangeRate, p.price.rateDate, p.price.rateSource ?? null, p.price.chargesSek ?? '0', p.price.landed, source,
          `Imported (${p.price.formula})`, me.id,
        );
        priced++;
      }
    }
    if (p.previousPriceSek && !db.get('SELECT id FROM material_prices WHERE material_id = ? AND undated = 1 AND landed_unit_price_sek = ?', mid, p.previousPriceSek)) {
      db.run(
        `INSERT INTO material_prices (material_id, effective_date, entry_mode, price, currency, exchange_rate, landed_unit_price_sek, source, undated, notes, created_by)
         VALUES (?, NULL, 'per_unit', ?, 'SEK', '1', ?, ?, 1, 'Previous price from Batchworks export (date unknown)', ?)`,
        mid, p.previousPriceSek, p.previousPriceSek, source, me.id,
      );
    }
  }
  return { summary: { created, updated, priced, skipped } };
}

function ensureMaterial(db: DB, me: SessionUser, importId: number, name: string, baseUnit: string, category: string, reason: string): number {
  const existing = db.get<Row>('SELECT id FROM materials WHERE lower(name) = lower(?)', name);
  if (existing) return existing.id;
  let code = name.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
  for (let i = 2; db.get('SELECT id FROM materials WHERE code = ?', code); i++) code = `${code}-${i}`;
  const id = db.run(
    "INSERT INTO materials (code, name, category, base_unit, review_status, review_notes, import_batch_id) VALUES (?,?,?,?, 'needs_review', ?, ?)",
    code, name, category, baseUnit, reason, importId,
  ).lastInsertRowid;
  audit(db, me, 'material', id, 'import', `Created ${name} from costing import (no price)`);
  return id;
}

export function applyCosting(db: DB, me: SessionUser, importId: number, a: CostingAnalysis, d: CostingDecisions) {
  const parsed = a.parsed;
  let productId = db.get<Row>('SELECT id FROM products WHERE code = ?', d.productCode)?.id as number | undefined;
  if (!productId) {
    productId = db.run('INSERT INTO products (code, name, description, output_unit, target_margin_pct) VALUES (?,?,?,?,?)',
      d.productCode, d.productName, parsed.header['Subtitle'] || null, d.fillUnit === 'kg' || d.fillUnit === 'g' ? 'kg' : 'L', d.targetMarginPct || null).lastInsertRowid;
    audit(db, me, 'product', productId, 'import', `Created product ${d.productName} from Batchworks import`);
  } else if (d.targetMarginPct) {
    db.run('UPDATE products SET target_margin_pct = COALESCE(target_margin_pct, ?) WHERE id = ?', d.targetMarginPct, productId);
  }
  const versionNo = (db.get<Row>('SELECT MAX(version_no) AS n FROM recipe_versions WHERE product_id = ?', productId)?.n ?? 0) + 1;
  const unresolved: string[] = [];
  if (!d.confirmed) unresolved.push('Batch and unit interpretation not confirmed by a reviewer.');
  if (parsed.labour.length && d.labourChoice === 'unresolved') unresolved.push('Labour rate/hours interpretation unresolved.');
  if (parsed.packaging.length && (!d.fillQty || !d.qtyPerPackage)) unresolved.push('Packaging fill or quantity per package not set.');
  for (const i of a.issues.filter((x) => x.level === 'warning' && !['Labor', 'Packaging', 'Ingredients'].includes(x.field ?? ''))) unresolved.push(i.message);

  const vid = db.run(
    `INSERT INTO recipe_versions (product_id, version_no, status, reference_batch_qty, default_batch_qty, yield_mode, yield_pct, notes, review_status, review_notes, import_batch_id, import_original_json, created_by)
     VALUES (?,?, 'draft', ?,?, 'direct', ?, ?, ?, ?, ?, ?, ?)`,
    productId, versionNo, d.referenceBatchQty, d.defaultBatchQty, d.yieldPct,
    `Imported from Batchworks export dated ${parsed.header['Exported'] ?? 'unknown'}. Quantities are for a ${parsed.header['Batch']} reference batch.`,
    unresolved.length ? 'needs_review' : 'ok', unresolved.join('\n') || null, importId,
    JSON.stringify({ header: parsed.header, ingredients: parsed.ingredients, packaging: parsed.packaging, labour: parsed.labour, summary: parsed.summary, lineChecks: a.lineChecks, totals: a.totals, issues: a.issues, decisions: d }),
    me.id,
  ).lastInsertRowid;

  let line = 1;
  for (const ing of parsed.ingredients) {
    const mapped = d.materialMap[ing.name];
    const mid = typeof mapped === 'number' && db.get('SELECT id FROM materials WHERE id = ?', mapped)
      ? mapped
      : ensureMaterial(db, me, importId, ing.name, ['kg', 'L', 'pc'].includes(ing.per) ? ing.per : 'kg', 'raw', `Created from costing import of ${d.productName}; price not provided.${['kg', 'L', 'pc'].includes(ing.per) ? '' : ` Price unit "${ing.per}" not recognised: base unit set to kg, verify.`}`);
    const unitOk = isQtyUnit(ing.unit);
    if (!unitOk) unresolved.push(`${ing.name}: unit "${ing.unit}" not recognised; quantity left blank.`);
    db.run('INSERT INTO recipe_ingredients (recipe_version_id, line_no, material_id, quantity, unit, note, needs_review) VALUES (?,?,?,?,?,?,?)',
      vid, line++, mid, unitOk ? ing.quantity : null, unitOk ? ing.unit : 'g', unitOk ? 'Imported from Batchworks' : `Batchworks: ${ing.quantity} ${ing.unit} (unit not recognised)`, unitOk ? 0 : 1);
  }

  let cl = 1;
  for (const l of parsed.labour) {
    const orig = `Export: rate ${l.rate} SEK, ${l.hours} h, cost ${l.cost} SEK`;
    const ins = (basis: string, rate: string | null, hours: string | null, review: boolean) => db.run(
      'INSERT INTO recipe_cost_items (recipe_version_id, line_no, category, description, basis, rate, hours, hours_scale, needs_review, note) VALUES (?,?,?,?,?,?,?,0,?,?)',
      vid, cl++, 'labour', l.name || 'Labour', basis, rate, hours, review ? 1 : 0, orig);
    if (d.labourChoice === 'fixed') ins('fixed', l.cost, null, false);
    else if (d.labourChoice === 'rate_x_hours') ins('per_hour', l.rate, l.hours, false);
    else if (d.labourChoice === 'swapped') ins('per_hour', l.hours, l.rate, false);
    else if (d.labourChoice === 'unresolved') ins('per_hour', null, null, true);
  }

  if (parsed.packaging.length) {
    const fid = db.run('INSERT INTO packaging_formats (product_id, name, fill_qty, fill_unit, needs_review, notes) VALUES (?,?,?,?,?,?)',
      productId, d.packagingName || 'Imported packaging', d.fillQty || null, d.fillUnit, d.confirmed && d.fillQty && d.qtyPerPackage ? 0 : 1,
      `From Batchworks: ${parsed.packaging.map((p) => `${p.name} ×${p.perUnit} @ ${p.unitPrice}`).join('; ')}`).lastInsertRowid;
    for (const p of parsed.packaging) {
      const mapped = d.materialMap[p.name];
      const mid = typeof mapped === 'number' && db.get('SELECT id FROM materials WHERE id = ?', mapped) ? mapped : ensureMaterial(db, me, importId, p.name, 'pc', 'packaging', 'Created from costing import; price not provided.');
      db.run('INSERT INTO packaging_components (format_id, material_id, qty_per_package) VALUES (?,?,?)', fid, mid, d.qtyPerPackage || null);
    }
  }
  if (unresolved.length) db.run("UPDATE recipe_versions SET review_status = 'needs_review', review_notes = ? WHERE id = ?", unresolved.join('\n'), vid);
  audit(db, me, 'recipe_version', vid, 'import', `Imported ${d.productName} v${versionNo} (${unresolved.length ? 'needs review' : 'reviewed'})`);
  return { summary: { productId, recipeVersionId: vid, versionNo, needsReview: unresolved.length > 0, unresolved }, productId, recipeVersionId: vid };
}
