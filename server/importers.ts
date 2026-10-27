import { parseCsv, rowsToObjects } from './csv';
import type { DB, Row } from './db';
import { today } from './db';
import { Decimal, dec, str } from '../shared/decimal';
import { landedUnitPrice } from '../shared/materialPrice';
import { BASE_UNITS, QTY_UNITS, type BaseUnit, type QtyUnit } from '../shared/engine';

export interface Issue {
  level: 'error' | 'warning' | 'info';
  field?: string;
  message: string;
}

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
const near = (a: Decimal, b: Decimal, abs = 0.011, rel = 0.005) => a.minus(b).abs().lte(Decimal.max(abs, b.abs().times(rel)));

/* ------------------------------------------------------------------ */
/* Format detection                                                    */
/* ------------------------------------------------------------------ */

export function detectFormat(text: string): 'batchworks_materials' | 'batchworks_costing' | 'materials_csv' | 'unknown' {
  const first = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? '';
  if (first.startsWith('Batchworks costing,')) return 'batchworks_costing';
  if (/^Code,Name,Type,Supplier,Pack,Pack price \(SEK\)/.test(first)) return 'batchworks_materials';
  if (/^code,name,category/i.test(first)) return 'materials_csv';
  return 'unknown';
}

/* ------------------------------------------------------------------ */
/* Batchworks materials export                                          */
/* ------------------------------------------------------------------ */

export interface MaterialProposal {
  rowNo: number;
  original: Record<string, string>;
  action: 'create' | 'add_price' | 'skip';
  existingId: number | null;
  material: {
    code: string; name: string; category: string; supplier: string | null; baseUnit: BaseUnit | null;
    purityPct: string | null; notes: string | null;
  };
  price: null | {
    entryMode: 'per_unit'; price: string; currency: string; exchangeRate: string; rateDate: string | null; rateSource: string | null;
    effectiveDate: string; landed: string; formula: string;
  };
  previousPriceSek: string | null;
  issues: Issue[];
  needsReview: boolean;
}

export function analyzeBatchworksMaterials(db: DB, text: string): { proposals: MaterialProposal[]; fileIssues: Issue[] } {
  const { header, records } = rowsToObjects(parseCsv(text));
  const fileIssues: Issue[] = [];
  const required = ['Code', 'Name', 'Type', 'Unit price (SEK)', 'Per'];
  for (const r of required) if (!header.includes(r)) fileIssues.push({ level: 'error', message: `Missing column "${r}".` });
  if (fileIssues.length) return { proposals: [], fileIssues };

  const proposals: MaterialProposal[] = records.map((o, idx) => {
    const issues: Issue[] = [];
    const code = slug(o['Code'] || o['Name'] || '');
    const per = o['Per'];
    const baseUnit = (BASE_UNITS as string[]).includes(per) ? (per as BaseUnit) : null;
    if (!code) issues.push({ level: 'error', field: 'Code', message: 'Row has no code or name.' });
    if (!baseUnit) issues.push({ level: 'error', field: 'Per', message: `Unsupported unit "${per}". Expected kg, L or pc.` });
    const category = o['Type'] === 'packaging' ? 'packaging' : /^water$/i.test(o['Name']) ? 'water' : 'raw';

    const csvUnit = dec(o['Unit price (SEK)']);
    const invAmt = dec(o['Invoice amount']);
    const invCur = (o['Invoice currency'] || '').toUpperCase();
    const rate = dec(o['Rate']);
    const invDate = o['Invoice date'] || null;
    const updated = o['Price updated'] || null;
    if (!updated) issues.push({ level: 'warning', field: 'Price updated', message: `No price date in the export; today (${today()}) is used as the effective date. Correct it if needed.` });
    let price: MaterialProposal['price'] = null;

    if (invAmt && invCur && rate) {
      const lr = landedUnitPrice({ entryMode: 'per_unit', price: invAmt.toFixed(), currency: invCur, exchangeRate: rate.toFixed() }, baseUnit ?? 'kg');
      if (lr.ok) {
        price = {
          entryMode: 'per_unit', price: invAmt.toFixed(), currency: invCur, exchangeRate: invCur === 'SEK' ? '1' : rate.toFixed(),
          rateDate: invDate, rateSource: o['Rate source'] || null, effectiveDate: updated || today(), landed: lr.landed, formula: lr.formula,
        };
        if (csvUnit && !near(new Decimal(lr.landed), csvUnit)) {
          issues.push({ level: 'warning', field: 'Unit price (SEK)', message: `Invoice amount × rate = ${new Decimal(lr.landed).toFixed(4)} SEK, but the export shows ${csvUnit.toFixed()} SEK.` });
        }
      }
    } else if (csvUnit) {
      price = { entryMode: 'per_unit', price: csvUnit.toFixed(), currency: 'SEK', exchangeRate: '1', rateDate: null, rateSource: null, effectiveDate: updated || today(), landed: csvUnit.toFixed(), formula: `${csvUnit.toFixed()} SEK/${per} (from export unit price)` };
      issues.push({ level: 'info', message: 'No invoice amount; the SEK unit price from the export is used directly.' });
    } else {
      issues.push({ level: 'warning', field: 'Unit price (SEK)', message: 'No price. The material will be created without a price (never treated as zero).' });
    }

    if (price && price.currency !== 'SEK') {
      if (!invDate) issues.push({ level: 'warning', field: 'Invoice date', message: `Exchange rate ${rate?.toFixed()} SEK/${invCur} has no date (no invoice date). Confirm which date the rate applies to.` });
      else if (updated && updated > invDate && daysBetween(invDate, updated) > 31) {
        issues.push({ level: 'warning', field: 'Rate', message: `Price updated ${updated}, but the invoice and its rate are from ${invDate}. The SEK price may use an outdated exchange rate.` });
      }
    }

    const packQty = o['Pack'];
    const packPrice = dec(o['Pack price (SEK)']);
    let notes: string | null = null;
    if (packQty) {
      notes = `Batchworks pack size: ${packQty} (unit not stated in export).`;
      if (packPrice && csvUnit && packPrice.eq(csvUnit) && dec(packQty)?.gt(1)) {
        issues.push({ level: 'warning', field: 'Pack price (SEK)', message: `Pack is ${packQty} but pack price equals unit price (${packPrice.toFixed()} SEK). The "pack price" appears to be per ${per}, not per pack. Imported as unit price only.` });
      } else if (!packPrice) {
        issues.push({ level: 'info', field: 'Pack', message: `Pack size ${packQty} has no unit or pack price; stored as a note, not used in calculations.` });
      }
    }
    const purity = dec(o['Purity (%)']);
    if (purity && !purity.eq(100)) issues.push({ level: 'info', field: 'Purity (%)', message: `Purity ${purity.toFixed()}% is stored but not applied to cost.` });
    const prev = dec(o['Previous price (SEK)']);
    if (prev) issues.push({ level: 'info', field: 'Previous price (SEK)', message: `Previous price ${prev.toFixed()} SEK/${per} has no date; kept as undated history.` });

    const existing = code ? db.get<Row>('SELECT id FROM materials WHERE code = ?', code) : undefined;
    return {
      rowNo: idx + 2, original: o, action: issues.some((i) => i.level === 'error') ? 'skip' : existing ? 'add_price' : 'create',
      existingId: existing?.id ?? null,
      material: { code, name: o['Name'], category, supplier: o['Supplier'] || null, baseUnit, purityPct: purity ? purity.toFixed() : null, notes },
      price, previousPriceSek: prev ? prev.toFixed() : null, issues, needsReview: false,
    };
  });

  // Cross-row checks
  const byAmt = new Map<string, MaterialProposal[]>();
  for (const p of proposals) {
    const a = p.original['Invoice amount'];
    if (!a) continue;
    const key = new Decimal(a).toFixed();
    byAmt.set(key, [...(byAmt.get(key) ?? []), p]);
  }
  const words = (n: string) => new Set(n.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !/^\d+$/.test(w)));
  const related = (a: string, b: string) => { const wa = words(a); return [...words(b)].some((w) => wa.has(w)); };
  for (const group of byAmt.values()) {
    if (group.length < 2) continue;
    for (const g of group) {
      const others = group.filter((o) => o !== g);
      const sameCur = others.filter((o) => o.original['Invoice currency'] === g.original['Invoice currency']);
      const diffCurRelated = others.filter((o) => o.original['Invoice currency'] !== g.original['Invoice currency'] && related(o.material.name, g.material.name));
      if (diffCurRelated.length) {
        g.issues.push({ level: 'warning', field: 'Invoice amount', message: `Same invoice amount ${g.original['Invoice amount']} as ${diffCurRelated.map((o) => `${o.material.name} (${o.original['Invoice currency']})`).join(', ')}, but in ${g.original['Invoice currency']}. Similar names: check for a duplicate or wrong currency.` });
      }
      if (sameCur.length) {
        g.issues.push({ level: 'info', field: 'Invoice amount', message: `Identical price (${g.original['Invoice amount']} ${g.original['Invoice currency']}) to ${sameCur.map((o) => o.material.name).join(', ')}. Verify it was not copied.` });
      }
    }
  }
  for (const p of proposals) p.needsReview = p.issues.some((i) => i.level !== 'info');
  return { proposals, fileIssues };
}

function daysBetween(a: string, b: string) {
  return Math.abs((Date.parse(b) - Date.parse(a)) / 86400000);
}

/* ------------------------------------------------------------------ */
/* Batchworks costing export (one recipe per file)                      */
/* ------------------------------------------------------------------ */

export interface ParsedCosting {
  productName: string;
  header: Record<string, string>;
  ingredients: { name: string; quantity: string; unit: string; unitPrice: string; per: string; cost: string }[];
  packaging: { name: string; perUnit: string; unitPrice: string; per: string; cost: string }[];
  labour: { name: string; rate: string; hours: string; cost: string }[];
  summary: Record<string, string[]>;
}

export function parseBatchworksCosting(text: string): ParsedCosting {
  const rows = parseCsv(text).map((r) => r.map((c) => c.trim()));
  if (rows[0]?.[0] !== 'Batchworks costing') throw new Error('Not a Batchworks costing export.');
  const out: ParsedCosting = { productName: rows[0][1], header: {}, ingredients: [], packaging: [], labour: [], summary: {} };
  let section: 'header' | 'ingredients' | 'packaging' | 'labour' | 'summary' = 'header';
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const blank = r.every((c) => c === '');
    if (blank) {
      if (section === 'header') section = 'summary';
      continue;
    }
    if (r[0] === 'Ingredients' && r[1] === 'Quantity') { section = 'ingredients'; continue; }
    if (r[0] === 'Packaging' && r[1] === 'Per unit') { section = 'packaging'; continue; }
    if (r[0] === 'Labor' && r[1] === 'Rate (SEK)') { section = 'labour'; continue; }
    if (section === 'header') out.header[r[0]] = r[1] ?? '';
    else if (section === 'ingredients' && r.length >= 6) out.ingredients.push({ name: r[0], quantity: r[1], unit: r[2], unitPrice: r[3], per: r[4], cost: r[5] });
    else if (section === 'packaging' && r.length >= 5) out.packaging.push({ name: r[0], perUnit: r[1], unitPrice: r[2], per: r[3], cost: r[4] });
    else if (section === 'labour' && r.length >= 4 && dec(r[1]) !== null) out.labour.push({ name: r[0], rate: r[1], hours: r[2], cost: r[3] });
    else out.summary[r[0]] = r.slice(1);
    // Rows in ingredient/packaging sections that do not match their shape fall through to summary (e.g. "Ingredients,2059.57,20.5%").
    if ((section === 'ingredients' && r.length < 6) || (section === 'packaging' && r.length < 5) || (section === 'labour' && dec(r[1]) === null)) {
      out.summary[r[0]] = r.slice(1);
      section = 'summary';
    }
  }
  return out;
}

export interface CostingDecisions {
  productCode: string;
  productName: string;
  referenceBatchQty: string;
  defaultBatchQty: string;
  yieldPct: string;
  targetMarginPct: string | null;
  labourChoice: 'unresolved' | 'fixed' | 'rate_x_hours' | 'swapped' | 'exclude';
  packagingName: string;
  fillQty: string | null;
  fillUnit: QtyUnit;
  qtyPerPackage: string | null;
  waterQty: string | null;
  waterUnit: QtyUnit;
  confirmed: boolean;
  materialMap: Record<string, number | 'create'>;
}

export interface CostingAnalysis {
  parsed: ParsedCosting;
  issues: Issue[];
  lineChecks: { name: string; original: string; computedRaw: string | null; ratio: string | null; materialId: number | null; matchedName: string | null; currentPrice: string | null; note?: string }[];
  multiplier: string | null;
  multiplierConsistent: boolean;
  proposed: CostingDecisions;
  existingProductId: number | null;
  totals: { label: string; original: string | null; recomputed: string | null; ok: boolean }[];
}

export function analyzeBatchworksCosting(db: DB, text: string, pendingMaterialNames: string[] = []): CostingAnalysis {
  const parsed = parseBatchworksCosting(text);
  const issues: Issue[] = [];
  const h = parsed.header;
  const batchMatch = /^([\d.]+)\s*(\w+)$/.exec(h['Batch'] ?? '');
  const refQty = batchMatch ? batchMatch[1] : null;
  const refUnit = batchMatch ? batchMatch[2] : null;
  if (!refQty || (refUnit !== 'L' && refUnit !== 'kg')) issues.push({ level: 'error', field: 'Batch', message: `Cannot read batch size "${h['Batch']}".` });
  const sellable = dec(h['Sellable units']);
  const planned = dec(h['Planned units']);
  const yieldPct = dec(h['Yield %']);

  // Ingredient cost reconciliation → infer the multiplier the export applied.
  const ratios: Decimal[] = [];
  for (const ing of parsed.ingredients) {
    if (!isQtyUnit(ing.unit)) issues.push({ level: 'error', field: 'Unit', message: `${ing.name}: quantity unit "${ing.unit}" is not recognised (g, kg, mL, L, pc). The quantity will be left blank for review.` });
  }
  if (!h['Yield %']) issues.push({ level: 'warning', field: 'Yield %', message: 'No yield in the export; 100 % is proposed. Confirm the expected yield.' });
  const lineChecks: CostingAnalysis['lineChecks'] = parsed.ingredients.map((ing) => {
    const q = dec(ing.quantity);
    const p = dec(ing.unitPrice);
    const c = dec(ing.cost);
    const mat = db.get<Row>('SELECT id, name, base_unit FROM materials WHERE lower(name) = lower(?) AND archived = 0', ing.name);
    let currentPrice: string | null = null;
    if (mat) {
      currentPrice = db.get<Row>(`SELECT landed_unit_price_sek FROM material_prices WHERE material_id = ? AND undated = 0 AND effective_date <= ? ORDER BY effective_date DESC, id DESC LIMIT 1`, mat.id, today())?.landed_unit_price_sek ?? null;
    }
    const pending = !mat && pendingMaterialNames.some((n) => n.toLowerCase() === ing.name.toLowerCase());
    let computed: Decimal | null = null;
    if (q && p) {
      const factor = ing.unit === ing.per ? new Decimal(1) : ing.unit === 'g' && ing.per === 'kg' ? new Decimal('0.001') : ing.unit === 'mL' && ing.per === 'L' ? new Decimal('0.001') : null;
      if (factor) computed = q.times(factor).times(p);
    }
    let ratio: Decimal | null = null;
    if (computed && c && computed.gt(0)) {
      ratio = c.div(computed);
      ratios.push(ratio);
    }
    return {
      name: ing.name, original: ing.cost, computedRaw: computed ? computed.toDecimalPlaces(4).toFixed() : null,
      ratio: ratio ? ratio.toDecimalPlaces(3).toFixed() : null, materialId: mat?.id ?? null, matchedName: mat?.name ?? null,
      currentPrice, note: !mat ? (pending ? 'Will match the material created by the pending materials import' : 'No material with this name; one will be created without a price') : undefined,
    };
  });

  let multiplier: Decimal | null = null;
  let consistent = false;
  if (ratios.length) {
    // Exports round each cost to ~3 significant digits, so compare with tolerance.
    const candidate = sellable ?? ratios[0];
    consistent = ratios.every((r) => near(r, candidate, 0.02, 0.02));
    multiplier = consistent ? candidate : null;
  }
  if (consistent && multiplier && !multiplier.eq(1)) {
    issues.push({ level: 'info', field: 'Cost (SEK)', message: `Each exported ingredient cost equals quantity × price × ${multiplier.toFixed()}, i.e. the export scaled the ${h['Batch']} recipe to a ${multiplier.toFixed()} ${refUnit} production batch. Imported as: reference batch ${h['Batch']}, production batch ${multiplier.toFixed()} ${refUnit}; scaling is applied once by the calculator.` });
  } else if (!consistent && ratios.length) {
    issues.push({ level: 'warning', field: 'Cost (SEK)', message: 'Ingredient costs do not follow one consistent scale factor. Check each line below.' });
  }
  if (sellable && planned && yieldPct && refQty && !sellable.eq(planned.times(yieldPct).div(100))) {
    issues.push({ level: 'info', field: 'Sellable units', message: `Header shows ${h['Planned units']} planned unit(s) at ${h['Yield %']}% yield but ${h['Sellable units']} sellable units. Per your confirmation, "Sellable units" is treated as the litres produced, not packages.` });
  }

  if (!parsed.labour.length) issues.push({ level: 'info', field: 'Labor', message: 'No labour recorded. Costs are ingredients (and packaging) only until labour, testing and overhead are added.' });
  for (const l of parsed.labour) {
    issues.push({ level: 'info', field: 'Labor', message: `Labour "${l.name}" (rate ${l.rate} SEK, ${l.hours} h, ${l.cost} SEK) is not imported by default: labour is entered per production batch. The original values are kept for reference.` });
  }
  if (!parsed.packaging.length) issues.push({ level: 'info', field: 'Packaging', message: 'No packaging in the export. Add a packaging format before quoting packaged units.' });
  for (const p of parsed.packaging) {
    if (sellable && dec(p.perUnit)?.eq(sellable) && !sellable.eq(1)) {
      issues.push({ level: 'warning', field: 'Packaging', message: `"${p.name}" shows ${p.perUnit} under "Per unit", which equals the ${sellable.toFixed()} units in the batch. This is most likely the batch total, i.e. 1 per package.` });
    }
  }
  const overhead = Object.keys(parsed.summary).find((k) => k.startsWith('Overhead'));
  if (overhead && /\(0(\.0)?%\)/.test(overhead)) issues.push({ level: 'info', field: 'Overhead', message: 'Export overhead is 0%. No overhead line is created.' });

  // Totals recomputation (original export math)
  const totals: CostingAnalysis['totals'] = [];
  const ingSum = parsed.ingredients.reduce((s, i) => s.plus(dec(i.cost) ?? 0), new Decimal(0));
  const pkgSum = parsed.packaging.reduce((s, i) => s.plus(dec(i.cost) ?? 0), new Decimal(0));
  const labSum = parsed.labour.reduce((s, i) => s.plus(dec(i.cost) ?? 0), new Decimal(0));
  const chk = (label: string, orig: string | undefined, val: Decimal) => {
    const o = dec(orig);
    totals.push({ label, original: orig ?? null, recomputed: val.toDecimalPlaces(2).toFixed(2), ok: !!o && near(o, val, 0.02) });
  };
  chk('Ingredients', parsed.summary['Ingredients']?.[0], ingSum);
  chk('Packaging', parsed.summary['Packaging']?.[0], pkgSum);
  chk('Labour', parsed.summary['Labor']?.[0], labSum);
  const total = ingSum.plus(pkgSum).plus(labSum);
  chk('Batch total', parsed.summary['Batch total']?.[0], total);
  if (sellable && sellable.gt(0)) chk('Cost / unit', parsed.summary['Cost / unit']?.[0], total.div(sellable));
  for (const t of totals) if (!t.ok && t.original) issues.push({ level: 'warning', field: t.label, message: `${t.label}: export shows ${t.original}, recomputed ${t.recomputed}.` });

  const sellKey = Object.keys(parsed.summary).find((k) => k.startsWith('Sell price'));
  const marginMatch = sellKey ? /margin ([\d.]+)%/.exec(sellKey) : null;
  const margin = marginMatch ? dec(marginMatch[1]) : null;
  if (sellKey) {
    issues.push({ level: 'info', field: 'Sell price', message: margin && margin.gt(0)
      ? `Export suggests ${parsed.summary[sellKey][0]} SEK at ${margin.toFixed()}% margin. Imported as a target margin only, not an approved price. "Profit" figures are gross, not company net profit.`
      : 'Export margin is 0% (no target set). No target margin is imported.' });
  }

  const productCode = slug(parsed.productName);
  const existing = db.get<Row>('SELECT id FROM products WHERE code = ? OR lower(name) = lower(?)', productCode, parsed.productName);
  const pkg = parsed.packaging[0];
  const defaultBatch = multiplier ?? sellable ?? new Decimal(refQty ?? '1');
  const unitsInBatch = pkg ? dec(pkg.perUnit) : null;
  const fillDefault = unitsInBatch && unitsInBatch.gt(0) ? defaultBatch.div(unitsInBatch) : null;

  const materialMap: Record<string, number | 'create'> = {};
  for (const lc of lineChecks) materialMap[lc.name] = lc.materialId ?? 'create';
  for (const p of parsed.packaging) {
    const m = db.get<Row>('SELECT id FROM materials WHERE lower(name) = lower(?)', p.name);
    materialMap[p.name] = m?.id ?? 'create';
  }

  return {
    parsed, issues, lineChecks, multiplier: str(multiplier), multiplierConsistent: consistent, existingProductId: existing?.id ?? null, totals,
    proposed: {
      productCode, productName: parsed.productName, referenceBatchQty: refQty ?? '1', defaultBatchQty: defaultBatch.toFixed(),
      yieldPct: yieldPct?.toFixed() ?? '100', targetMarginPct: margin && margin.gt(0) ? margin.toFixed() : null,
      labourChoice: 'exclude',
      packagingName: pkg ? `${pkg.name}${fillDefault ? ` (${str(fillDefault)} ${refUnit} fill)` : ''}` : '',
      fillQty: fillDefault ? str(fillDefault) : null, fillUnit: (refUnit === 'kg' ? 'kg' : 'L') as QtyUnit,
      qtyPerPackage: pkg ? '1' : null, waterQty: null, waterUnit: 'mL', confirmed: false, materialMap,
    },
  };
}

export function isQtyUnit(u: string): u is QtyUnit {
  return (QTY_UNITS as string[]).includes(u);
}
