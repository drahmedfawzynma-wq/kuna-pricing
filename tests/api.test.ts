import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { hashPassword } from '../server/auth';

const SAMPLE = path.resolve(__dirname, '../sample-data');
let app: FastifyInstance;
let dbFile: string;
const cookies: Record<string, string> = {};

async function call(who: string | null, method: string, url: string, payload?: unknown) {
  const res = await app.inject({
    method: method as any, url, payload: payload as any,
    headers: { 'x-kuna-request': '1', ...(who && cookies[who] ? { cookie: cookies[who] } : {}) },
  });
  let body: any = res.body;
  try { body = JSON.parse(res.body); } catch { /* text */ }
  return { status: res.statusCode, body, headers: res.headers };
}

async function login(who: string, email: string, password: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password }, headers: { 'x-kuna-request': '1' } });
  expect(res.statusCode).toBe(200);
  const set = res.headers['set-cookie'];
  cookies[who] = (Array.isArray(set) ? set[0] : set)!.split(';')[0];
}

beforeAll(async () => {
  dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kuna-')), 'test.db');
  app = await buildApp({ dbFile });
  // First-run setup creates the admin.
  const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { 'x-kuna-request': '1' }, payload: { email: 'admin@kuna.test', name: 'Admin', password: 'admin-password-1' } });
  expect(setup.statusCode).toBe(200);
  for (const role of ['production', 'quality', 'sales']) {
    app.db.run('INSERT INTO users (email, name, role, password_hash) VALUES (?,?,?,?)', `${role}@kuna.test`, role, role, hashPassword(`${role}-password-1`));
  }
  await login('admin', 'admin@kuna.test', 'admin-password-1');
  await login('production', 'production@kuna.test', 'production-password-1');
  await login('quality', 'quality@kuna.test', 'quality-password-1');
  await login('sales', 'sales@kuna.test', 'sales-password-1');
});
afterAll(async () => { await app.close(); });

describe('security basics', () => {
  it('rejects unauthenticated access', async () => {
    expect((await call(null, 'GET', '/api/materials')).status).toBe(401);
  });
  it('rejects state changes without the CSRF header', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/materials', headers: { cookie: cookies.admin }, payload: {} });
    expect(res.statusCode).toBe(403);
  });
  it('setup cannot run twice', async () => {
    expect((await call(null, 'POST', '/api/auth/setup', { email: 'x@example.com', name: 'x', password: 'xxxxxxxxxxxx' })).status).toBe(409);
  });
});

let materialId: number;
let productId: number;
let versionId: number;
let formatId: number;
let bottleId: number;
let customerId: number;
let quoteId: number;

describe('complete workflow: material → recipe → batch costing → price → quotation', () => {
  it('adds a material and prices it (2 kg / 500 g acceptance via costing)', async () => {
    const m = await call('production', 'POST', '/api/materials', { code: 'TEST-SUGAR', name: 'Test sugar', category: 'raw', baseUnit: 'kg' });
    expect(m.status).toBe(200);
    materialId = m.body.id;
    const p = await call('production', 'POST', `/api/materials/${materialId}/prices`, { effectiveDate: '2026-01-01', entryMode: 'per_unit', price: '50', currency: 'SEK' });
    expect(p.status).toBe(200);
    expect(p.body.landed).toBe('50');
  });

  it('pack price requires pack quantity and unit; EUR pack converts to SEK per kg', async () => {
    const bad = await call('production', 'POST', `/api/materials/${materialId}/prices/preview`, { effectiveDate: '2026-01-01', entryMode: 'per_pack', price: '100', currency: 'SEK' });
    expect(bad.status).toBe(400);
    const ok = await call('production', 'POST', `/api/materials/${materialId}/prices/preview`, { effectiveDate: '2026-01-01', entryMode: 'per_pack', packQty: '25', packUnit: 'kg', price: '100', currency: 'EUR', exchangeRate: '11', chargesSek: '50' });
    expect(ok.body.landed).toBe('46'); // (100×11 + 50) / 25
  });

  it('creates a product with an editable recipe and recalculates', async () => {
    const r = await call('production', 'POST', '/api/products', { code: 'TEST-EXT', name: 'Test extract', outputUnit: 'L' });
    expect(r.status).toBe(200);
    productId = r.body.id;
    versionId = r.body.recipeVersionId;
    const b = await call('production', 'POST', '/api/materials', { code: 'TEST-BOTTLE', name: 'Test bottle', category: 'packaging', baseUnit: 'pc' });
    bottleId = b.body.id;
    await call('production', 'POST', `/api/materials/${bottleId}/prices`, { effectiveDate: '2026-01-01', entryMode: 'per_unit', price: '5', currency: 'SEK' });
    const save = await call('production', 'PUT', `/api/recipe-versions/${versionId}`, {
      referenceBatchQty: '100', defaultBatchQty: '100', yieldMode: 'direct', yieldPct: '100', lossStages: [],
      ingredients: [{ materialId, quantity: '200', unit: 'kg' }],
      costItems: [],
    });
    expect(save.status).toBe(200);
    const f = await call('production', 'POST', `/api/products/${productId}/packaging`, { name: '1 L bottle', fillQty: '1', fillUnit: 'L', components: [{ materialId: bottleId, qtyPerPackage: '1' }] });
    formatId = f.body.id;
  });

  it('10,000 SEK / 100 L = 100 SEK/L and / 80 L = 125 SEK/L', async () => {
    const a = await call('production', 'POST', '/api/costings/calculate', { recipeVersionId: versionId });
    expect(a.body.totalBatchCost).toBe('10000');
    expect(a.body.costPerOutputUnit).toBe('100');
    const b = await call('production', 'POST', '/api/costings/calculate', { recipeVersionId: versionId, yieldPctOverride: '80' });
    expect(b.body.costPerOutputUnit).toBe('125');
  });

  it('scales once: 200 L batch doubles ingredient cost', async () => {
    const r = await call('production', 'POST', '/api/costings/calculate', { recipeVersionId: versionId, batchQty: '200' });
    expect(r.body.sections.ingredients).toBe('20000');
    expect(r.body.scaleFactor).toBe('2');
  });

  it('saves and reloads a costing snapshot and recipe edits', async () => {
    const s = await call('production', 'POST', '/api/costings', { recipeVersionId: versionId, packagingFormatId: formatId, name: 'Base estimate' });
    expect(s.status).toBe(200);
    const g = await call('production', 'GET', `/api/costings/${s.body.id}`);
    expect(g.body.result.costPerPackage).toBe('105'); // 100 SEK/L + 5 SEK bottle
    const v = await call('production', 'GET', `/api/recipe-versions/${versionId}`);
    expect(v.body.ingredients[0].quantity).toBe('200');
  });

  it('approves the recipe; approved versions cannot be edited', async () => {
    expect((await call('production', 'POST', `/api/recipe-versions/${versionId}/approve`)).status).toBe(200);
    const edit = await call('production', 'PUT', `/api/recipe-versions/${versionId}`, { referenceBatchQty: '100', yieldMode: 'direct', yieldPct: '100', lossStages: [], ingredients: [], costItems: [] });
    expect(edit.status).toBe(409);
  });

  it('prices: 30% margin and 30% markup; approval by admin only', async () => {
    const pm = await call('admin', 'POST', '/api/prices', { recipeVersionId: versionId, packagingFormatId: formatId, priceUnit: 'package', method: 'margin', methodValue: '30', minQty: '1' });
    expect(pm.status).toBe(200);
    expect(pm.body.price).toBe('150.00'); // 105 / 0.7
    const mk = await call('admin', 'POST', '/api/prices', { recipeVersionId: versionId, packagingFormatId: formatId, priceUnit: 'package', method: 'markup', methodValue: '30', minQty: '100' });
    expect(mk.body.price).toBe('136.50');
    expect((await call('admin', 'POST', '/api/prices', { recipeVersionId: versionId, packagingFormatId: formatId, priceUnit: 'package', method: 'margin', methodValue: '100' })).status).toBe(400);
    expect((await call('production', 'POST', `/api/prices/${pm.body.id}/approve`)).status).toBe(403);
    expect((await call('admin', 'POST', `/api/prices/${pm.body.id}/approve`)).status).toBe(200);
    expect((await call('admin', 'POST', `/api/prices/${mk.body.id}/approve`)).status).toBe(200);
  });

  it('sales creates a quotation using approved prices and volume tiers', async () => {
    const customers = await call('sales', 'GET', '/api/customers');
    customerId = customers.body.find((c: any) => c.name === 'Bluewater Sweden').id;
    expect(customerId).toBeTruthy();
    const q = await call('sales', 'POST', '/api/quotations', {
      customerId, quoteDate: '2026-10-27', validUntil: '2026-11-26', deliveryCharge: '250', vatPct: '25',
      lines: [
        { productId, packagingFormatId: formatId, quantity: '10', priceUnit: 'package' },
        { productId, packagingFormatId: formatId, quantity: '120', priceUnit: 'package' },
      ],
    });
    expect(q.status).toBe(200);
    quoteId = q.body.id;
    expect(q.body.lines[0].unitPrice).toBe('150.00');
    expect(q.body.lines[1].unitPrice).toBe('136.50'); // tier ≥ 100
    expect(q.body.totals.subtotal).toBe('17880.00'); // 1500 + 16380
    expect(q.body.totals.totalExVat).toBe('18130.00');
    expect(q.body.lines[0].costing).toBeUndefined(); // sales sees no cost data
    // Sales cannot set a manual price.
    const manual = await call('sales', 'POST', '/api/quotations', { customerId, quoteDate: '2026-10-27', vatPct: '25', lines: [{ productId, packagingFormatId: formatId, quantity: '1', priceUnit: 'package', useApprovedPrice: false, unitPrice: '1' }] });
    expect(manual.body.lines?.[0]?.unitPrice ?? '').not.toBe('1.00');
    // Sales cannot approve.
    expect((await call('sales', 'POST', `/api/quotations/${quoteId}/approve`)).status).toBe(403);
  });

  it('admin approves the quotation; costing snapshot stored and quotation locked', async () => {
    const a = await call('admin', 'POST', `/api/quotations/${quoteId}/approve`);
    expect(a.status).toBe(200);
    expect(a.body.lines[0].costing.unitCost).toBe('105');
    expect(new Number(a.body.lines[0].costing.marginPct).toFixed(2)).toBe('30.00');
    expect((await call('admin', 'PUT', `/api/quotations/${quoteId}`, { customerId, quoteDate: '2026-10-27', vatPct: '25', lines: [] })).status).toBe(409);
  });

  it('printable quotation exposes no costs or recipes', async () => {
    const p = await call('sales', 'GET', `/api/quotations/${quoteId}/print`);
    const text = JSON.stringify(p.body);
    expect(text).not.toMatch(/costing|unitCost|margin|ingredient|recipe/i);
    expect(p.body.lines).toHaveLength(2);
  });
});

describe('historical integrity', () => {
  let batchId: number;
  it('completed batch costs are locked to their snapshot', async () => {
    const b = await call('production', 'POST', '/api/batches', { productId, packagingFormatId: formatId, plannedQty: '100' });
    expect(b.status).toBe(200);
    batchId = b.body.id;
    const pt = await call('production', 'PATCH', `/api/batches/${batchId}`, { status: 'in_production', actualOutputQty: '95', actualPackagedUnits: '95' });
    expect(pt.body.error ?? 'ok').toBe('ok');
    const c = await call('production', 'POST', `/api/batches/${batchId}/complete-costing`);
    expect(c.status).toBe(200);
    expect(c.body.actual.result.totalBatchCost).toBe('10475'); // 10000 + 95 × 5
  });

  it('a material price change updates estimates but not approved/completed records', async () => {
    await call('production', 'POST', `/api/materials/${materialId}/prices`, { effectiveDate: '2026-06-01', entryMode: 'per_unit', price: '60', currency: 'SEK' });
    const est = await call('production', 'POST', '/api/costings/calculate', { recipeVersionId: versionId });
    expect(est.body.costPerOutputUnit).toBe('120');
    const q = await call('admin', 'GET', `/api/quotations/${quoteId}`);
    expect(q.body.lines[0].unitPrice).toBe('150.00');
    expect(q.body.lines[0].costing.unitCost).toBe('105');
    const batch = await call('production', 'GET', `/api/batches/${batchId}`);
    expect(batch.body.actual.result.totalBatchCost).toBe('10475');
    expect(batch.body.estimate.result.totalBatchCost).toBe('10500');
    const v = await call('production', 'GET', `/api/recipe-versions/${versionId}`);
    expect(v.body.status).toBe('approved');
  });

  it('dashboard flags the product below target margin after the price rise', async () => {
    await call('admin', 'PATCH', `/api/products/${productId}`, { code: 'TEST-EXT', name: 'Test extract', outputUnit: 'L', targetMarginPct: '25' });
    const d = await call('admin', 'GET', '/api/dashboard');
    const p = d.body.products.find((x: any) => x.id === productId);
    const row = p.prices.find((r: any) => r.price === '150.00');
    expect(row.currentUnitCost).toBe('125');
    expect(row.belowTarget).toBe(true); // (150-125)/150 = 16.7% < 25%
  });

  it('QC release requires passing results for configured specs', async () => {
    const spec = await call('quality', 'POST', `/api/products/${productId}/quality-specs`, { parameter: 'pH', unit: 'pH', minValue: '2.5', maxValue: '3.5' });
    expect(spec.status).toBe(200);
    expect((await call('quality', 'POST', `/api/batches/${batchId}/decision`, { decision: 'release' })).status).toBe(409);
    const r = await call('quality', 'POST', `/api/batches/${batchId}/qc-results`, { specId: spec.body.id, valueText: '3.1' });
    expect(r.body.result).toBe('pass');
    expect((await call('production', 'POST', `/api/batches/${batchId}/decision`, { decision: 'release' })).status).toBe(403);
    expect((await call('quality', 'POST', `/api/batches/${batchId}/decision`, { decision: 'release' })).status).toBe(200);
  });
});

describe('restricted roles cannot reach confidential data', () => {
  it('sales cannot read recipes, costs, material prices, margins or scenarios', async () => {
    expect((await call('sales', 'GET', `/api/recipe-versions/${versionId}`)).status).toBe(403);
    expect((await call('sales', 'POST', '/api/costings/calculate', { recipeVersionId: versionId })).status).toBe(403);
    expect((await call('sales', 'GET', '/api/costings')).status).toBe(403);
    expect((await call('sales', 'GET', '/api/scenarios')).status).toBe(403);
    expect((await call('sales', 'GET', '/api/materials/export.csv')).status).toBe(403);
    const mats = await call('sales', 'GET', '/api/materials');
    expect(JSON.stringify(mats.body)).not.toMatch(/currentPrice|landed/i);
    const prices = await call('sales', 'GET', '/api/prices');
    expect(JSON.stringify(prices.body)).not.toMatch(/unitCost|margin|costing/i);
    const products = await call('sales', 'GET', '/api/products');
    expect(JSON.stringify(products.body)).not.toMatch(/estimate|targetMargin|costPer/i);
    const dash = await call('sales', 'GET', '/api/dashboard');
    expect(JSON.stringify(dash.body)).not.toMatch(/costPer|unitCost|marginPct|landed/i);
  });
  it('sales and quality cannot edit recipes; quality cannot see costs', async () => {
    expect((await call('sales', 'POST', `/api/recipe-versions/${versionId}/new-version`)).status).toBe(403);
    expect((await call('quality', 'POST', `/api/recipe-versions/${versionId}/new-version`)).status).toBe(403);
    expect((await call('quality', 'POST', '/api/costings/calculate', { recipeVersionId: versionId })).status).toBe(403);
    const b = await call('quality', 'GET', '/api/batches');
    expect(JSON.stringify(b.body)).not.toMatch(/CostPerUnit/);
  });
  it('production cannot see margins or approve prices', async () => {
    expect((await call('production', 'GET', '/api/prices')).status).toBe(403);
    expect((await call('production', 'GET', '/api/quotations')).status).toBe(403);
  });
  it('editing an approved recipe creates a new version, preserving the old one', async () => {
    const n = await call('production', 'POST', `/api/recipe-versions/${versionId}/new-version`);
    expect(n.status).toBe(200);
    const nv = await call('production', 'GET', `/api/recipe-versions/${n.body.id}`);
    expect(nv.body.versionNo).toBe(2);
    expect(nv.body.status).toBe('draft');
  });
});

describe('Batchworks import', () => {
  it('previews and applies materials and all recipe exports, keeping originals and flags', async () => {
    const files = fs.readdirSync(SAMPLE).filter((f) => f.endsWith('.csv')).map((f) => ({ filename: f, text: fs.readFileSync(path.join(SAMPLE, f), 'utf8') }));
    const pv = await call('production', 'POST', '/api/imports/preview', { files });
    expect(pv.status).toBe(200);
    expect(pv.body.ids).toHaveLength(12);
    const first = await call('production', 'GET', `/api/imports/${pv.body.ids[0]}`);
    expect(first.body.kind).toBe('batchworks_materials');
    const b12 = first.body.parsed.proposals.find((p: any) => p.material.code === 'b12');
    expect(b12.issues.some((i: any) => /wrong currency/.test(i.message))).toBe(true);
    const bottleDup = first.body.parsed.proposals.find((p: any) => p.material.code === 'extract-label');
    expect(bottleDup.issues.some((i: any) => /wrong currency/.test(i.message))).toBe(false);
    const bottle = first.body.parsed.proposals.find((p: any) => p.material.code === '1-5-l-tritan-bottle');
    expect(bottle.issues.some((i: any) => /pack price equals unit price/.test(i.message))).toBe(true);
    expect((await call('production', 'POST', `/api/imports/${pv.body.ids[0]}/apply`, {})).status).toBe(200);

    for (const id of pv.body.ids.slice(1)) {
      const imp = await call('production', 'GET', `/api/imports/${id}`);
      const a = imp.body.parsed;
      if (a.parsed.productName === 'Strawberry Concentrate') {
        expect(a.multiplier).toBe('50');
        expect(a.proposed.defaultBatchQty).toBe('50');
        expect(a.proposed.referenceBatchQty).toBe('1');
        expect(a.proposed.labourChoice).toBe('exclude');
        expect(a.lineChecks.every((l: any) => l.materialId)).toBe(true);
      }
      if (a.parsed.productName === 'Focus Concentrate') expect(a.multiplier).toBe('1.5');
      const ap = await call('production', 'POST', `/api/imports/${id}/apply`, {});
      expect(ap.status).toBe(200);
      expect(ap.body.summary.needsReview).toBe(true); // interpretation not yet confirmed
    }
    const products = await call('production', 'GET', '/api/products');
    const straw = products.body.find((p: any) => p.name === 'Strawberry Concentrate');
    expect(straw.currentVersion.reviewStatus).toBe('needs_review');
    const sv = await call('production', 'GET', `/api/recipe-versions/${straw.currentVersion.id}`);
    expect(sv.body.ingredients.some((i: any) => /water/i.test(i.materialName ?? ''))).toBe(false);
    expect(sv.body.costItems).toHaveLength(0); // labour not imported
    const calc = await call('production', 'POST', '/api/costings/calculate', { recipeVersionId: straw.currentVersion.id });
    expect(calc.body.batchQty).toBe('50');
    expect(Number(calc.body.sections.ingredients).toFixed(2)).toBe('2059.57'); // scaled once from 1 L
  });

  it('a confirmed import with labour as fixed and water entered reproduces the export total plus water', async () => {
    const pv = await call('production', 'POST', '/api/imports/preview', { files: [{ filename: 's.csv', text: fs.readFileSync(path.join(SAMPLE, 'batchworks-strawberry-concentrate-2026-10-27.csv'), 'utf8').replace('Strawberry Concentrate', 'Strawberry Concentrate Reviewed') }] });
    const ap = await call('production', 'POST', `/api/imports/${pv.body.ids[0]}/apply`, { decisions: { labourChoice: 'fixed', waterQty: '850', waterUnit: 'mL', confirmed: true } });
    expect(ap.status).toBe(200);
    const fmt = (await call('production', 'GET', `/api/products/${ap.body.productId}`)).body.packagingFormats[0];
    const c = await call('production', 'POST', '/api/costings/calculate', { recipeVersionId: ap.body.recipeVersionId, packagingFormatId: fmt.id });
    expect(c.body.packagedUnits).toBe('50');
    // reproduces the export total (unrounded 10037.466); no water line is ever added
    expect(Number(c.body.totalBatchCost).toFixed(2)).toBe('10037.47');
  });
});

describe('review fixes: leaks and locks', () => {
  it('sales and quality do not receive imported prices, review notes or cost rates', async () => {
    const mats = await call('sales', 'GET', '/api/materials');
    const s = JSON.stringify(mats.body);
    expect(s).not.toMatch(/importOriginal|reviewNotes|Invoice|SEK/);
    const one = await call('sales', 'GET', `/api/materials/${mats.body.find((m: any) => m.code === 'gum-arabic').id}`);
    expect(JSON.stringify(one.body)).not.toMatch(/Invoice|SEK|importOriginal/);
    const products = await call('production', 'GET', '/api/products');
    const straw = products.body.find((p: any) => p.name === 'Strawberry Concentrate');
    const q = await call('quality', 'GET', `/api/recipe-versions/${straw.currentVersion.id}`);
    expect(q.status).toBe(200);
    expect(q.body.importOriginal).toBeNull();
    expect(q.body.costItems.every((c: any) => c.rate === null)).toBe(true);
    expect(JSON.stringify(q.body)).not.toMatch(/SEK/);
  });
  it('a packaging format used by prices cannot change its fill', async () => {
    const r = await call('production', 'PUT', `/api/packaging/${formatId}`, { name: '1 L bottle', fillQty: '0.5', fillUnit: 'L', components: [{ materialId: bottleId, qtyPerPackage: '1' }] });
    expect(r.status).toBe(409);
    const rename = await call('production', 'PUT', `/api/packaging/${formatId}`, { name: '1 L bottle (renamed)', fillQty: '1', fillUnit: 'L', components: [{ materialId: bottleId, qtyPerPackage: '1' }] });
    expect(rename.status).toBe(200);
    const quote = await call('admin', 'GET', `/api/quotations/${quoteId}/print`);
    expect(quote.body.lines[0].packagingName).toBe('1 L bottle'); // approved quotation keeps its snapshot
  });
  it('sales unit cannot change once used', async () => {
    expect((await call('admin', 'PATCH', `/api/products/${productId}`, { code: 'TEST-EXT', name: 'Test extract', outputUnit: 'kg', targetMarginPct: '25' })).status).toBe(409);
  });
  it('batches require an approved recipe version', async () => {
    const products = await call('production', 'GET', '/api/products');
    const draftOnly = products.body.find((p: any) => p.name === 'Zen Concentrate');
    expect((await call('production', 'POST', '/api/batches', { productId: draftOnly.id, plannedQty: '1' })).status).toBe(409);
  });
  it('approving a draft re-checks that its prices are still approved', async () => {
    const d = await call('sales', 'POST', '/api/quotations', { customerId, quoteDate: '2026-10-27', vatPct: '25', lines: [{ productId, packagingFormatId: formatId, quantity: '10', priceUnit: 'package' }] });
    expect(d.status).toBe(200);
    const np = await call('admin', 'POST', '/api/prices', { recipeVersionId: versionId, packagingFormatId: formatId, priceUnit: 'package', method: 'manual', price: '199', minQty: '1' });
    await call('admin', 'POST', `/api/prices/${np.body.id}/approve`);
    const ap = await call('admin', 'POST', `/api/quotations/${d.body.id}/approve`);
    expect(ap.status).toBe(409);
    expect(ap.body.error).toMatch(/price has changed/);
  });
});

describe('batch-specific costs', () => {
  it('labour entered for a batch is added to that batch only', async () => {
    const base = await call('production', 'POST', '/api/costings/calculate', { recipeVersionId: versionId, packagingFormatId: formatId });
    const withLabour = await call('production', 'POST', '/api/costings/calculate', { recipeVersionId: versionId, packagingFormatId: formatId, extraCosts: [{ category: 'labour', description: '2 operators', amount: '1200' }] });
    expect(Number(withLabour.body.totalBatchCost) - Number(base.body.totalBatchCost)).toBe(1200);
    expect(withLabour.body.sections.labour).toBe('1200');
    const b = await call('production', 'POST', '/api/batches', { productId, packagingFormatId: formatId, plannedQty: '100', extraCosts: [{ category: 'labour', description: 'Shift', amount: '900' }] });
    expect(b.status).toBe(200);
    expect(b.body.estimate.result.sections.labour).toBe('900');
    const v = await call('production', 'GET', `/api/recipe-versions/${versionId}`);
    expect(v.body.costItems).toHaveLength(0); // recipe itself unchanged
  });
});

describe('sales volumes in the standard container', () => {
  it('prices 500 mL of Citrus filled in the 1.5 L Tritan bottle and reuses the format', async () => {
    const products = await call('admin', 'GET', '/api/products');
    const citrus = products.body.find((p: any) => p.name === 'Citrus Concentrate');
    const c = await call('admin', 'POST', '/api/costings/calculate', { recipeVersionId: citrus.currentVersion.id, sellVolume: { qty: '500', unit: 'mL' } });
    expect(c.status).toBe(200);
    expect(c.body.packagingPerPackage).toBe('139.558');
    expect(c.body.packagedUnits).toBe('2');
    expect(Number(c.body.costPerPackage).toFixed(2)).toBe((79.156 / 2 + 139.558).toFixed(2));
    const p1 = await call('admin', 'POST', '/api/prices', { recipeVersionId: citrus.currentVersion.id, sellVolume: { qty: '500', unit: 'mL' }, priceUnit: 'package', method: 'margin', methodValue: '60' });
    expect(p1.status).toBe(200);
    const p2 = await call('admin', 'POST', '/api/prices', { recipeVersionId: citrus.currentVersion.id, sellVolume: { qty: '0.5', unit: 'L' }, priceUnit: 'package', method: 'margin', methodValue: '65' });
    const p3 = await call('admin', 'POST', '/api/prices', { recipeVersionId: citrus.currentVersion.id, sellVolume: { qty: '500', unit: 'mL' }, priceUnit: 'package', method: 'margin', methodValue: '65' });
    expect(p3.body.packagingFormatId).toBe(p1.body.packagingFormatId);
    const prod = await call('admin', 'GET', `/api/products/${citrus.id}`);
    const f = prod.body.packagingFormats.find((x: any) => x.id === p1.body.packagingFormatId);
    expect(f.name).toBe('500 mL in 1.5 L Tritan bottle');
    expect(f.components).toHaveLength(3);
    expect(p2.status).toBe(200);
  });
});

describe('outsourced production (partner batches)', () => {
  let partnerId: number;
  let pbId: number;
  let ingredients: number;
  it('partners: production manages them; quality sees no fee; sales has no access', async () => {
    const p = await call('production', 'POST', '/api/partners', { name: 'Co-packer A (test)', feeBasis: 'per_output_qty', feeRate: '35' });
    expect(p.status).toBe(200);
    partnerId = p.body.id;
    expect((await call('quality', 'POST', '/api/partners', { name: 'X' })).status).toBe(403);
    const q = await call('quality', 'GET', '/api/partners');
    expect(q.status).toBe(200);
    expect(q.body.find((x: any) => x.id === partnerId).feeRate).toBeUndefined();
    expect((await call('sales', 'GET', '/api/partners')).status).toBe(403);
  });

  it('plans a partner batch: partner fee and freight replace in-house costs; in-house comparison stored', async () => {
    const calc = await call('production', 'POST', '/api/costings/calculate', { recipeVersionId: versionId, batchQty: '100' });
    ingredients = Number(calc.body.sections.ingredients);
    const r = await call('production', 'POST', '/api/partner-batches', { partnerId, productId, plannedQty: '100', freightOut: '650', freightBack: '900', inhouseExtraCosts: [{ category: 'labour', description: 'Shift', amount: '3200' }] });
    expect(r.status).toBe(200);
    pbId = r.body.id;
    expect(r.body.partnerName).toBe('Co-packer A (test)');
    expect(Number(r.body.estimate.result.totalBatchCost)).toBeCloseTo(ingredients + 3500 + 650 + 900, 6);
    expect(r.body.estimate.result.sections.labour).toBe('0');
    expect(Number(r.body.inhouse.result.totalBatchCost)).toBeCloseTo(ingredients + 3200, 6);
    expect(r.body.inputs.length).toBeGreaterThan(0);
    // Quality sees the batch but not its partner fee or costs.
    const qb = await call('quality', 'GET', `/api/batches/${pbId}`);
    expect(qb.body.partnerFeeRate).toBeUndefined();
    expect(qb.body.inhouse).toBeUndefined();
  });

  it('cannot use the in-house actual cost routes or skip sending', async () => {
    expect((await call('production', 'POST', `/api/batches/${pbId}/complete-costing`)).status).toBe(409);
    expect((await call('production', 'PATCH', `/api/batches/${pbId}`, { status: 'in_production' })).status).toBe(409);
    expect((await call('production', 'POST', `/api/partner-batches/${pbId}/receive`, { receivedDate: '2026-10-20', receivedQty: '96' })).status).toBe(409);
  });

  it('send records supplier lots; receive locks fee × received litres + freight at the prices frozen when sent', async () => {
    const b = await call('production', 'GET', `/api/batches/${pbId}`);
    const s = await call('production', 'POST', `/api/partner-batches/${pbId}/send`, { sentDate: '2026-10-12', lots: [{ inputId: b.body.inputs[0].id, lot: 'L-3301' }] });
    expect(s.status).toBe(200);
    expect(s.body.status).toBe('in_production');
    expect(s.body.inputs[0].supplier_lot).toBe('L-3301');
    // A later price change must not change what was sent.
    await call('production', 'POST', `/api/materials/${materialId}/prices`, { effectiveDate: '2026-10-15', entryMode: 'per_unit', price: '999', currency: 'SEK' });
    const r = await call('production', 'POST', `/api/partner-batches/${pbId}/receive`, { receivedDate: '2026-10-20', receivedQty: '96', partnerLot: 'CPA-1', freightBack: '1000', lock: true });
    expect(r.status).toBe(200);
    expect(r.body.costsLocked).toBe(true);
    const total = ingredients + 35 * 96 + 650 + 1000;
    expect(Number(r.body.actual.result.totalBatchCost)).toBeCloseTo(total, 6);
    expect(Number(r.body.actual.result.costPerOutputUnit)).toBeCloseTo(total / 96, 6);
    expect((await call('production', 'POST', `/api/partner-batches/${pbId}/receive`, { receivedDate: '2026-10-20', receivedQty: '90', lock: true })).status).toBe(409);
  });

  it('dashboard uses the partner batch as the latest actual cost', async () => {
    const d = await call('admin', 'GET', '/api/dashboard');
    const p = d.body.products.find((x: any) => x.id === productId);
    expect(p.latestActual.partnerName).toBe('Co-packer A (test)');
    expect(d.body.lockedBatches.length).toBeGreaterThan(0);
    const s = await call('sales', 'GET', '/api/dashboard');
    expect(s.body.products).toBeUndefined();
    expect(s.body.partnerBatches).toBeUndefined();
  });
});
