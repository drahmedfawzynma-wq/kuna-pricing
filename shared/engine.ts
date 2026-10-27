/**
 * Kuna costing engine. Pure functions shared by the server (authoritative values,
 * snapshots) and the client (instant recalculation). No I/O.
 */
import { Decimal, dec, money, str } from './decimal';

export type QtyUnit = 'g' | 'kg' | 'mL' | 'L' | 'pc';
export type BaseUnit = 'kg' | 'L' | 'pc';
export type OutputUnit = 'kg' | 'L';

export const QTY_UNITS: QtyUnit[] = ['g', 'kg', 'mL', 'L', 'pc'];
export const BASE_UNITS: BaseUnit[] = ['kg', 'L', 'pc'];

export const COST_CATEGORIES = {
  consumable: 'Processing consumables',
  labour: 'Labour',
  setup_cleaning: 'Setup and cleaning',
  testing: 'Quality testing',
  utilities_equipment: 'Utilities and equipment',
  overhead: 'Manufacturing overhead',
  other: 'Other production charges',
  outsourcing: 'Outsourced production (partner fee, freight)',
} as const;
export type CostCategory = keyof typeof COST_CATEGORIES;

export const COST_BASES = {
  fixed: 'Fixed amount per batch',
  per_hour: 'Hourly rate × hours',
  per_batch_qty: 'Rate per L/kg of batch size',
  per_output_qty: 'Rate per L/kg of sellable output',
  step: 'Rate per started step of batch size',
  percent: 'Percentage of other production costs',
} as const;
export type CostBasis = keyof typeof COST_BASES;

export type PercentBase = 'ingredients' | 'conversion' | 'production';
export const PERCENT_BASES: Record<PercentBase, string> = {
  ingredients: 'ingredient cost',
  conversion: 'conversion costs (non-percentage lines, excl. ingredients and packaging)',
  production: 'ingredients + conversion costs (excl. packaging)',
};

export interface MaterialPrice {
  id: number;
  code: string;
  name: string;
  baseUnit: BaseUnit;
  densityKgPerL: string | null;
  /** Landed price in SEK per base unit, or null when no usable price exists. */
  unitPriceSek: string | null;
  priceDate?: string | null;
  priceId?: number | null;
  needsReview?: boolean;
}

export interface IngredientLine {
  id?: number;
  materialId: number | null;
  quantity: string | null;
  unit: QtyUnit;
  note?: string | null;
}

export interface CostItem {
  id?: number;
  category: CostCategory;
  description: string;
  basis: CostBasis;
  rate: string | null;
  hours?: string | null;
  hoursScale?: boolean;
  stepSize?: string | null;
  percentBase?: PercentBase | null;
  includesUtilities?: boolean;
  needsReview?: boolean;
}

export interface LossStage {
  name: string;
  pct: string;
}

export interface PackagingComponent {
  materialId: number | null;
  /** Quantity of the component per package, in the component material's base unit. */
  qtyPerPackage: string | null;
}

export interface PackagingFormat {
  id?: number;
  name: string;
  fillQty: string | null;
  fillUnit: QtyUnit;
  components: PackagingComponent[];
  needsReview?: boolean;
}

export interface RecipeForCosting {
  outputUnit: OutputUnit;
  referenceBatchQty: string | null;
  yieldMode: 'direct' | 'stages';
  yieldPct: string | null;
  lossStages: LossStage[];
  ingredients: IngredientLine[];
  costItems: CostItem[];
}

export interface CostingInput {
  recipe: RecipeForCosting;
  /** Selected production scale (batch size before losses), in the recipe output unit. */
  batchQty: string | null;
  /** Optional yield override for scenarios / batch planning (percent). */
  yieldPctOverride?: string | null;
  packaging?: PackagingFormat | null;
  materials: Record<number, MaterialPrice>;
  /** Scenario-only overrides: materialId -> SEK per base unit. */
  priceOverrides?: Record<number, string>;
  /** Actual accepted sellable output (actual costing only). Replaces expected output. */
  actualOutputQty?: string | null;
  /** Actual packaged units (actual costing only). */
  actualPackagedUnits?: string | null;
  /** Costs specific to this batch (e.g. labour entered per production batch). Fixed SEK amounts, not scaled. */
  extraCosts?: BatchCost[];
}

export interface BatchCost {
  category: CostCategory;
  description: string;
  amount: string | null;
}

export type LineStatus = 'ok' | 'missing' | 'error';

export interface CostLine {
  section: 'ingredients' | CostCategory | 'packaging';
  ref: string;
  label: string;
  materialId?: number | null;
  quantity?: string | null;
  quantityUnit?: string | null;
  rate?: string | null;
  rateUnit?: string | null;
  formula: string;
  amount: string | null; // unrounded SEK
  status: LineStatus;
  message?: string;
  priceOverridden?: boolean;
}

export interface Warning {
  level: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  ref?: string;
}

export interface CostingResult {
  outputUnit: OutputUnit;
  scaleFactor: string | null;
  referenceBatchQty: string | null;
  batchQty: string | null;
  yieldPct: string | null;
  yieldSource: 'recipe' | 'stages' | 'override' | 'actual';
  expectedOutputQty: string | null;
  /** Denominator used for cost per output unit. */
  sellableQty: string | null;
  packagedUnits: string | null;
  fillQtyInOutputUnit: string | null;
  fillRemainder: string | null;
  lines: CostLine[];
  sections: Record<string, string>;
  productionCost: string | null;
  packagingCost: string | null;
  packagingPerPackage: string | null;
  totalBatchCost: string | null;
  costPerOutputUnit: string | null;
  costPerPackage: string | null;
  complete: boolean;
  basis: 'estimate' | 'actual';
  warnings: Warning[];
}

const DIM: Record<QtyUnit, 'mass' | 'volume' | 'count'> = {
  g: 'mass', kg: 'mass', mL: 'volume', L: 'volume', pc: 'count',
};
const TO_BASE: Record<QtyUnit, string> = { g: '0.001', kg: '1', mL: '0.001', L: '1', pc: '1' };

export function unitDimension(u: QtyUnit) {
  return DIM[u];
}

export type ConversionResult = { ok: true; value: Decimal; note?: string } | { ok: false; error: string };

/**
 * Convert a quantity into a target base unit. Mass <-> volume requires a density
 * in kg/L; it is never assumed.
 */
export function convertQty(
  qty: Decimal,
  from: QtyUnit,
  to: BaseUnit | QtyUnit,
  densityKgPerL?: string | null,
): ConversionResult {
  const fromDim = DIM[from];
  const toDim = DIM[to as QtyUnit];
  if (!fromDim || !toDim) return { ok: false, error: `Unknown unit ${from} or ${to}` };
  const inBase = qty.times(TO_BASE[from]); // kg, L or pc
  if (fromDim === toDim) return { ok: true, value: inBase.div(TO_BASE[to as QtyUnit]) };
  if (fromDim === 'count' || toDim === 'count') {
    return { ok: false, error: `Cannot convert ${from} to ${to}: pieces are not interchangeable with mass or volume` };
  }
  const density = dec(densityKgPerL);
  if (!density || density.lte(0)) {
    return { ok: false, error: `Converting ${from} to ${to} needs the material's density (kg/L). No density is recorded.` };
  }
  // mass (kg) -> volume (L): divide by density; volume (L) -> mass (kg): multiply.
  const converted = fromDim === 'mass' ? inBase.div(density) : inBase.times(density);
  return {
    ok: true,
    value: converted.div(TO_BASE[to as QtyUnit]),
    note: `density ${density.toFixed()} kg/L`,
  };
}

export function fmt(d: Decimal | string | null | undefined, dp = 4): string {
  const v = typeof d === 'string' ? dec(d) : d;
  if (!v) return '—';
  const fixed = v.toDecimalPlaces(dp, Decimal.ROUND_HALF_UP).toFixed();
  return fixed;
}

function fmtMoney(d: Decimal | null) {
  return d ? `${money(d)} SEK` : '—';
}

export function effectiveYield(recipe: RecipeForCosting): { pct: Decimal | null; source: 'recipe' | 'stages'; error?: string } {
  if (recipe.yieldMode === 'stages') {
    let y = new Decimal(1);
    for (const s of recipe.lossStages) {
      const p = dec(s.pct);
      if (!p || p.lt(0) || p.gte(100)) return { pct: null, source: 'stages', error: `Loss stage "${s.name}" must be a percentage from 0 to below 100` };
      y = y.times(new Decimal(1).minus(p.div(100)));
    }
    return { pct: y.times(100), source: 'stages' };
  }
  const p = dec(recipe.yieldPct);
  if (!p) return { pct: null, source: 'recipe', error: 'Expected yield is not set' };
  return { pct: p, source: 'recipe' };
}

export function calculateCosting(input: CostingInput): CostingResult {
  const { recipe } = input;
  const warnings: Warning[] = [];
  const lines: CostLine[] = [];
  const outputUnit = recipe.outputUnit;
  const actual = input.actualOutputQty !== undefined && input.actualOutputQty !== null && input.actualOutputQty !== '';

  const ref = dec(recipe.referenceBatchQty);
  const batch = dec(input.batchQty);
  let scale: Decimal | null = null;
  if (!ref || ref.lte(0)) warnings.push({ level: 'error', code: 'ref_batch', message: 'Reference batch size must be greater than zero.' });
  if (!batch || batch.lte(0)) warnings.push({ level: 'error', code: 'batch', message: 'Selected batch size must be greater than zero.' });
  if (ref && batch && ref.gt(0) && batch.gt(0)) scale = batch.div(ref);

  // Yield
  let yieldPct: Decimal | null = null;
  let yieldSource: CostingResult['yieldSource'] = 'recipe';
  const override = dec(input.yieldPctOverride);
  if (input.yieldPctOverride !== undefined && input.yieldPctOverride !== null && input.yieldPctOverride !== '') {
    yieldPct = override;
    yieldSource = 'override';
    if (!override) warnings.push({ level: 'error', code: 'yield', message: 'Yield override is not a number.' });
  } else {
    const y = effectiveYield(recipe);
    yieldPct = y.pct;
    yieldSource = y.source;
    if (y.error) warnings.push({ level: 'error', code: 'yield', message: y.error });
  }
  if (yieldPct && (yieldPct.lte(0) || yieldPct.gt(100))) {
    warnings.push({ level: 'error', code: 'yield', message: 'Yield must be above 0% and at most 100%.' });
    yieldPct = null;
  }
  const expectedOutput = batch && yieldPct ? batch.times(yieldPct).div(100) : null;
  let bulkSellable = expectedOutput;
  if (actual) {
    const a = dec(input.actualOutputQty);
    if (!a || a.lte(0)) {
      warnings.push({ level: 'error', code: 'actual_output', message: 'Actual accepted output must be greater than zero.' });
      bulkSellable = null;
    } else {
      bulkSellable = a;
      yieldSource = 'actual';
      if (batch) yieldPct = a.div(batch).times(100);
    }
  }

  // Ingredients — quantities are for the reference batch; scaled exactly once here.
  let ingredients = new Decimal(0);
  let incomplete = false;
  recipe.ingredients.forEach((ing, i) => {
    const r = `ing-${i}`;
    const mat = ing.materialId != null ? input.materials[ing.materialId] : undefined;
    const label = mat ? mat.name : 'Unselected material';
    const q = dec(ing.quantity);
    const base: CostLine = { section: 'ingredients', ref: r, label, materialId: ing.materialId, quantityUnit: ing.unit, formula: '', amount: null, status: 'error' };
    if (!mat) {
      lines.push({ ...base, formula: 'No material selected', message: 'Select a material' });
      incomplete = true;
      return;
    }
    if (!q || q.lt(0)) {
      lines.push({ ...base, formula: 'Quantity missing or invalid', message: 'Enter a quantity' });
      incomplete = true;
      return;
    }
    if (!scale) {
      lines.push({ ...base, quantity: str(q), formula: 'Cannot scale: batch sizes invalid' });
      incomplete = true;
      return;
    }
    const scaled = q.times(scale);
    const conv = convertQty(scaled, ing.unit, mat.baseUnit, mat.densityKgPerL);
    if (!conv.ok) {
      lines.push({ ...base, quantity: str(scaled), formula: conv.error, message: conv.error });
      warnings.push({ level: 'error', code: 'conversion', message: `${mat.name}: ${conv.error}`, ref: r });
      incomplete = true;
      return;
    }
    const overridden = input.priceOverrides?.[mat.id];
    const price = dec(overridden ?? mat.unitPriceSek);
    const scaleText = scale.eq(1) ? '' : ` × ${fmt(scale, 6)} (scale)`;
    const qtyText = `${fmt(q, 6)} ${ing.unit}${scaleText}`;
    const baseText = `${fmt(conv.value, 6)} ${mat.baseUnit}${conv.note ? ` (${conv.note})` : ''}`;
    if (!price) {
      lines.push({ ...base, quantity: str(conv.value), quantityUnit: mat.baseUnit, formula: `${qtyText} = ${baseText} × missing price`, status: 'missing', message: 'No price recorded' });
      warnings.push({ level: 'warning', code: 'missing_price', message: `${mat.name} has no price. The costing is incomplete.`, ref: r });
      incomplete = true;
      return;
    }
    const amount = conv.value.times(price);
    ingredients = ingredients.plus(amount);
    if (mat.needsReview) warnings.push({ level: 'info', code: 'material_review', message: `${mat.name} is marked "Needs review".`, ref: r });
    lines.push({
      ...base,
      quantity: str(conv.value),
      quantityUnit: mat.baseUnit,
      rate: str(price),
      rateUnit: `SEK/${mat.baseUnit}`,
      formula: `${qtyText} = ${baseText} × ${fmt(price, 5)} SEK/${mat.baseUnit}${overridden ? ' (scenario price)' : ''} = ${fmtMoney(amount)}`,
      amount: str(amount),
      status: 'ok',
      priceOverridden: !!overridden,
    });
  });

  // Sellable output used by per-output cost lines: whole filled packages when packaged, so it matches the unit-cost denominator.
  let preFill: Decimal | null = null;
  if (input.packaging) {
    const fq = dec(input.packaging.fillQty);
    if (fq && fq.gt(0)) {
      const c = convertQty(fq, input.packaging.fillUnit, outputUnit);
      if (c.ok) preFill = c.value;
    }
  }
  const actualUnitsIn = dec(input.actualPackagedUnits);
  const preUnits = preFill && bulkSellable ? (actual && actualUnitsIn && actualUnitsIn.gt(0) ? actualUnitsIn.floor() : bulkSellable.div(preFill).floor()) : null;
  const outputForRates = preFill && preUnits ? preUnits.times(preFill) : bulkSellable;

  // Conversion cost items (all except percentage-based first)
  const sections: Record<string, Decimal> = { ingredients };
  for (const c of Object.keys(COST_CATEGORIES)) sections[c] = new Decimal(0);
  const percentItems: { item: CostItem; idx: number }[] = [];
  const costItems: CostItem[] = [
    ...recipe.costItems,
    ...(input.extraCosts ?? []).map((e) => ({
      category: e.category, basis: 'fixed' as const, rate: e.amount,
      description: `This batch: ${e.description || COST_CATEGORIES[e.category] || 'cost'}`,
    })),
  ];
  costItems.forEach((item, i) => {
    const r = `cost-${i}`;
    const base: CostLine = { section: item.category, ref: r, label: item.description || COST_CATEGORIES[item.category] || 'Cost line', formula: '', amount: null, status: 'error' };
    if (!(item.category in COST_CATEGORIES) || !(item.basis in COST_BASES)) {
      lines.push({ ...base, label: item.description || 'Unknown cost line', formula: 'Unknown category or basis', message: 'Unknown category or basis' });
      warnings.push({ level: 'error', code: 'cost_type', message: `${item.description || 'A cost line'} has an unknown category or basis.`, ref: r });
      incomplete = true;
      return;
    }
    if (item.basis === 'percent') {
      percentItems.push({ item, idx: i });
      return;
    }
    const rate = dec(item.rate);
    if (!rate || rate.lt(0)) {
      lines.push({ ...base, formula: 'Rate missing or invalid', status: 'missing', message: item.needsReview ? 'Unresolved import value: confirm the rate' : 'Enter a rate' });
      warnings.push({ level: 'warning', code: 'missing_rate', message: `${base.label}: rate is not set. The costing is incomplete.`, ref: r });
      incomplete = true;
      return;
    }
    let amount: Decimal | null = null;
    let formula = '';
    let qty: Decimal | null = null;
    let qtyUnit = '';
    let rateUnit = 'SEK';
    switch (item.basis) {
      case 'fixed':
        amount = rate;
        formula = `${fmtMoney(rate)} per batch (fixed, not scaled)`;
        rateUnit = 'SEK/batch';
        break;
      case 'per_hour': {
        const h = dec(item.hours);
        if (!h || h.lt(0)) break;
        qty = item.hoursScale && scale ? h.times(scale) : h;
        qtyUnit = 'h';
        rateUnit = 'SEK/h';
        amount = rate.times(qty);
        formula = `${fmt(h, 4)} h${item.hoursScale && scale && !scale.eq(1) ? ` × ${fmt(scale, 6)} (scale)` : item.hoursScale ? '' : ' (fixed per batch)'} × ${fmt(rate, 4)} SEK/h = ${fmtMoney(amount)}`;
        break;
      }
      case 'per_batch_qty':
        if (!batch) break;
        qty = batch;
        qtyUnit = outputUnit;
        rateUnit = `SEK/${outputUnit}`;
        amount = rate.times(batch);
        formula = `${fmt(batch, 4)} ${outputUnit} batch × ${fmt(rate, 4)} SEK/${outputUnit} = ${fmtMoney(amount)}`;
        break;
      case 'per_output_qty':
        if (!outputForRates || outputForRates.lte(0)) break;
        qty = outputForRates;
        qtyUnit = outputUnit;
        rateUnit = `SEK/${outputUnit}`;
        amount = rate.times(outputForRates);
        formula = `${fmt(outputForRates, 4)} ${outputUnit} sellable × ${fmt(rate, 4)} SEK/${outputUnit} = ${fmtMoney(amount)}`;
        break;
      case 'step': {
        const s = dec(item.stepSize);
        if (!s || s.lte(0) || !batch) break;
        const steps = batch.div(s).ceil();
        qty = steps;
        qtyUnit = 'steps';
        rateUnit = 'SEK/step';
        amount = rate.times(steps);
        formula = `ceil(${fmt(batch, 4)} ÷ ${fmt(s, 4)} ${outputUnit}) = ${steps.toFixed()} × ${fmtMoney(rate)} = ${fmtMoney(amount)}`;
        break;
      }
    }
    if (!amount) {
      const msg = item.basis === 'per_hour' ? 'Hours missing or invalid' : item.basis === 'step' ? 'Step size missing or invalid' : 'Batch or output quantity unavailable';
      lines.push({ ...base, rate: str(rate), formula: msg, message: msg, status: 'missing' });
      warnings.push({ level: 'warning', code: 'missing_qty', message: `${base.label}: ${msg}.`, ref: r });
      incomplete = true;
      return;
    }
    if (item.needsReview) warnings.push({ level: 'warning', code: 'cost_review', message: `${base.label} is an imported value marked "Needs review".`, ref: r });
    sections[item.category] = sections[item.category].plus(amount);
    lines.push({ ...base, quantity: qty ? str(qty) : null, quantityUnit: qtyUnit || null, rate: str(rate), rateUnit, formula, amount: str(amount), status: 'ok' });
  });

  const conversionNonPct = Object.keys(COST_CATEGORIES).reduce((s, c) => s.plus(sections[c]), new Decimal(0));
  for (const { item, idx } of percentItems) {
    const r = `cost-${idx}`;
    const label = item.description || COST_CATEGORIES[item.category];
    const rate = dec(item.rate);
    const pb: PercentBase = item.percentBase ?? 'production';
    const baseAmt = pb === 'ingredients' ? ingredients : pb === 'conversion' ? conversionNonPct : ingredients.plus(conversionNonPct);
    if (!rate || rate.lt(0)) {
      lines.push({ section: item.category, ref: r, label, formula: 'Percentage missing', amount: null, status: 'missing' });
      warnings.push({ level: 'warning', code: 'missing_rate', message: `${label}: percentage is not set.`, ref: r });
      incomplete = true;
      continue;
    }
    const amount = baseAmt.times(rate).div(100);
    sections[item.category] = sections[item.category].plus(amount);
    lines.push({
      section: item.category, ref: r, label, rate: str(rate), rateUnit: '%',
      formula: `${fmt(rate, 4)}% × ${fmtMoney(baseAmt)} (${PERCENT_BASES[pb]}) = ${fmtMoney(amount)}`,
      amount: str(amount), status: 'ok',
    });
  }

  // Double-counting guard: overhead declared to include utilities AND separate utility lines.
  const overheadIncludesUtilities = costItems.some((c) => c.category === 'overhead' && c.includesUtilities);
  const hasUtilityLines = costItems.some((c) => c.category === 'utilities_equipment');
  if (overheadIncludesUtilities && hasUtilityLines) {
    warnings.push({ level: 'error', code: 'double_count', message: 'An overhead line is marked as already including utilities, but separate utility/equipment lines also exist. Remove one to avoid counting the same cost twice.' });
  }

  const productionCost = ingredients.plus(Object.keys(COST_CATEGORIES).reduce((s, c) => s.plus(sections[c]), new Decimal(0)));

  // Packaging
  let packagingPerPackage: Decimal | null = null;
  let packagingCost: Decimal | null = null;
  let packagedUnits: Decimal | null = null;
  let fillInOutput: Decimal | null = null;
  let remainder: Decimal | null = null;
  let sellable = bulkSellable;
  const pkg = input.packaging;
  if (pkg) {
    const fq = dec(pkg.fillQty);
    if (!fq || fq.lte(0)) {
      warnings.push({ level: 'error', code: 'fill', message: `Packaging format "${pkg.name}" has no fill quantity.` });
      incomplete = true;
    } else {
      const conv = convertQty(fq, pkg.fillUnit, outputUnit);
      if (!conv.ok) {
        warnings.push({ level: 'error', code: 'fill', message: `Fill quantity for "${pkg.name}": ${conv.error}` });
        incomplete = true;
      } else fillInOutput = conv.value;
    }
    let per = new Decimal(0);
    let pkgOk = true;
    pkg.components.forEach((comp, i) => {
      const r = `pkg-${i}`;
      const mat = comp.materialId != null ? input.materials[comp.materialId] : undefined;
      const q = dec(comp.qtyPerPackage);
      if (!mat) {
        pkgOk = false;
        lines.push({ section: 'packaging', ref: r, label: 'Unselected component', formula: 'No material selected', amount: null, status: 'error' });
        return;
      }
      const overridden = input.priceOverrides?.[mat.id];
      const price = dec(overridden ?? mat.unitPriceSek);
      if (!q || q.lt(0)) {
        pkgOk = false;
        lines.push({ section: 'packaging', ref: r, label: mat.name, materialId: mat.id, formula: 'Quantity per package not set', amount: null, status: 'missing', message: pkg.needsReview ? 'Unresolved import value: confirm quantity per package' : 'Enter quantity per package' });
        warnings.push({ level: 'warning', code: 'pkg_qty', message: `${mat.name}: quantity per package is not set.`, ref: r });
        return;
      }
      if (!price) {
        pkgOk = false;
        lines.push({ section: 'packaging', ref: r, label: mat.name, materialId: mat.id, formula: `${fmt(q)} ${mat.baseUnit} per package × missing price`, amount: null, status: 'missing' });
        warnings.push({ level: 'warning', code: 'missing_price', message: `${mat.name} has no price. The costing is incomplete.`, ref: r });
        return;
      }
      const each = q.times(price);
      per = per.plus(each);
      lines.push({
        section: 'packaging', ref: r, label: mat.name, materialId: mat.id,
        quantity: str(q), quantityUnit: `${mat.baseUnit}/package`, rate: str(price), rateUnit: `SEK/${mat.baseUnit}`,
        formula: `${fmt(q)} ${mat.baseUnit} × ${fmt(price, 4)} SEK/${mat.baseUnit}${overridden ? ' (scenario price)' : ''} = ${fmtMoney(each)} per package`,
        amount: null, // filled after unit count is known
        status: 'ok', priceOverridden: !!overridden,
      });
    });
    if (!pkgOk) incomplete = true;
    packagingPerPackage = pkgOk ? per : null;

    const actualUnits = dec(input.actualPackagedUnits);
    if (actual && actualUnits && actualUnits.gt(0)) {
      packagedUnits = actualUnits.floor();
      if (fillInOutput) {
        sellable = packagedUnits.times(fillInOutput);
        if (bulkSellable && sellable.gt(bulkSellable)) {
          warnings.push({ level: 'error', code: 'units_exceed_output', message: `${packagedUnits.toFixed()} packages × ${fmt(fillInOutput)} ${outputUnit} = ${fmt(sellable)} ${outputUnit}, more than the ${fmt(bulkSellable)} ${outputUnit} actual accepted output.` });
        }
      }
    } else if (bulkSellable && fillInOutput) {
      packagedUnits = bulkSellable.div(fillInOutput).floor();
      sellable = packagedUnits.times(fillInOutput);
      remainder = bulkSellable.minus(sellable);
      if (remainder.gt(0)) {
        warnings.push({ level: 'info', code: 'remainder', message: `${fmt(remainder, 4)} ${outputUnit} cannot fill a whole package and is excluded from sellable output (treated as filling loss).` });
      }
    }
    if (packagedUnits && packagedUnits.lte(0)) {
      warnings.push({ level: 'error', code: 'zero_units', message: 'Sellable output is smaller than one package. Cost per package cannot be calculated.' });
      packagedUnits = null;
    }
    if (packagedUnits) {
      // Fill the per-line packaging amounts for the batch.
      for (const l of lines) {
        if (l.section === 'packaging' && l.status === 'ok' && l.quantity && l.rate) {
          const each = new Decimal(l.quantity).times(l.rate);
          const total = each.times(packagedUnits);
          l.amount = str(total);
          l.formula += ` × ${packagedUnits.toFixed()} packages = ${fmtMoney(total)}`;
        }
      }
      if (packagingPerPackage) packagingCost = packagingPerPackage.times(packagedUnits);
    }
  }

  const total = pkg ? (packagingCost ? productionCost.plus(packagingCost) : null) : productionCost;
  const sellableOk = sellable && sellable.gt(0) ? sellable : null;
  if (!sellableOk && !warnings.some((w) => w.code === 'zero_units')) {
    warnings.push({ level: 'error', code: 'zero_output', message: 'Sellable output is zero or unknown. Unit costs cannot be calculated.' });
  }
  const costPerOutput = total && sellableOk ? total.div(sellableOk) : null;
  const costPerPackage = total && packagedUnits ? total.div(packagedUnits) : null;

  const hasError = warnings.some((w) => w.level === 'error');
  const sectionsOut: Record<string, string> = {};
  for (const [k, v] of Object.entries(sections)) sectionsOut[k] = str(v)!;
  if (packagingCost) sectionsOut.packaging = str(packagingCost)!;

  return {
    outputUnit,
    scaleFactor: str(scale),
    referenceBatchQty: str(ref),
    batchQty: str(batch),
    yieldPct: str(yieldPct),
    yieldSource,
    expectedOutputQty: str(expectedOutput),
    sellableQty: str(sellableOk),
    packagedUnits: str(packagedUnits),
    fillQtyInOutputUnit: str(fillInOutput),
    fillRemainder: str(remainder),
    lines,
    sections: sectionsOut,
    productionCost: str(productionCost),
    packagingCost: str(packagingCost),
    packagingPerPackage: str(packagingPerPackage),
    totalBatchCost: str(total),
    costPerOutputUnit: str(costPerOutput),
    costPerPackage: str(costPerPackage),
    complete: !incomplete && !hasError && total !== null && costPerOutput !== null,
    basis: actual ? 'actual' : 'estimate',
    warnings,
  };
}

/** Simple cost for an ingredient amount; used in acceptance tests and quick previews. */
export function ingredientCost(qty: string, unit: QtyUnit, mat: Pick<MaterialPrice, 'baseUnit' | 'densityKgPerL' | 'unitPriceSek'>): ConversionResult {
  const q = dec(qty);
  const p = dec(mat.unitPriceSek);
  if (!q) return { ok: false, error: 'Invalid quantity' };
  if (!p) return { ok: false, error: 'Missing price' };
  const c = convertQty(q, unit, mat.baseUnit, mat.densityKgPerL);
  if (!c.ok) return c;
  return { ok: true, value: c.value.times(p) };
}
