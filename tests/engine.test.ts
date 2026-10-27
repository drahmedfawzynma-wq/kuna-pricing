import { describe, it, expect } from 'vitest';
import { calculateCosting, convertQty, ingredientCost, type CostingInput, type MaterialPrice } from '../shared/engine';
import { priceForMargin, priceForMarkup, marginPct, downstreamPrice, lineTotal } from '../shared/pricing';
import { Decimal } from '../shared/decimal';

const mat = (id: number, price: string | null, baseUnit: 'kg' | 'L' | 'pc' = 'kg', density: string | null = null): MaterialPrice => ({
  id, code: `m${id}`, name: `Material ${id}`, baseUnit, densityKgPerL: density, unitPriceSek: price,
});

describe('acceptance: ingredient cost', () => {
  it('2 kg at 50 SEK/kg costs 100 SEK', () => {
    const r = ingredientCost('2', 'kg', mat(1, '50'));
    expect(r.ok && r.value.toFixed(2)).toBe('100.00');
  });
  it('500 g at 50 SEK/kg costs 25 SEK', () => {
    const r = ingredientCost('500', 'g', mat(1, '50'));
    expect(r.ok && r.value.toFixed(2)).toBe('25.00');
  });
  it('mass to volume requires density', () => {
    expect(convertQty(new Decimal(1), 'kg', 'L').ok).toBe(false);
    const c = convertQty(new Decimal(1.2), 'kg', 'L', '1.2');
    expect(c.ok && c.value.toFixed()).toBe('1');
    expect(convertQty(new Decimal(1), 'pc', 'kg', '1').ok).toBe(false);
  });
});

function simpleInput(over: Partial<CostingInput> = {}, yieldPct = '100'): CostingInput {
  return {
    recipe: {
      outputUnit: 'L', referenceBatchQty: '100', yieldMode: 'direct', yieldPct, lossStages: [],
      ingredients: [{ materialId: 1, quantity: '100', unit: 'kg' }],
      costItems: [],
    },
    batchQty: '100',
    materials: { 1: mat(1, '100') },
    ...over,
  };
}

describe('acceptance: cost per sellable unit', () => {
  it('10,000 SEK / 100 sellable L = 100 SEK/L', () => {
    const r = calculateCosting(simpleInput());
    expect(r.totalBatchCost).toBe('10000');
    expect(r.costPerOutputUnit).toBe('100');
    expect(r.complete).toBe(true);
  });
  it('same cost / 80 sellable L = 125 SEK/L', () => {
    const r = calculateCosting(simpleInput({}, '80'));
    expect(r.totalBatchCost).toBe('10000');
    expect(r.sellableQty).toBe('80');
    expect(r.costPerOutputUnit).toBe('125');
  });
  it('actual accepted output replaces expected output as denominator', () => {
    const r = calculateCosting(simpleInput({ actualOutputQty: '80' }));
    expect(r.costPerOutputUnit).toBe('125');
    expect(r.basis).toBe('actual');
  });
});

describe('acceptance: pricing', () => {
  it('100 SEK cost with 30% markup = 130 SEK', () => {
    expect(priceForMarkup('100', '30')).toEqual({ ok: true, value: '130.00' });
  });
  it('100 SEK cost with 30% gross margin ≈ 142.86 SEK', () => {
    expect(priceForMargin('100', '30')).toEqual({ ok: true, value: '142.86' });
  });
  it('rejects margin of 100% or more and zero cost', () => {
    expect(priceForMargin('100', '100').ok).toBe(false);
    expect(priceForMargin('0', '30').ok).toBe(false);
    expect(marginPct('0', '10').ok).toBe(false);
  });
  it('margin from price', () => {
    const m = marginPct('142.86', '100');
    expect(m.ok && new Decimal(m.value).toDecimalPlaces(2).toFixed(2)).toBe('30.00');
  });
  it('downstream retail requires explicit assumptions', () => {
    expect(downstreamPrice({ acquisitionCost: '100', otherCostsPerUnit: '', marginPct: '40', vatPct: '12' }).ok).toBe(false);
    const d = downstreamPrice({ acquisitionCost: '100', otherCostsPerUnit: '20', marginPct: '40', vatPct: '12' });
    expect(d.ok && d.exVat).toBe('200.00');
    expect(d.ok && d.incVat).toBe('224.00');
  });
  it('quotation line total uses rounded unit price', () => {
    expect(lineTotal('142.857', '3')).toBe('428.58');
  });
});

describe('scaling and allocation', () => {
  const recipe = {
    outputUnit: 'L' as const, referenceBatchQty: '1', yieldMode: 'direct' as const, yieldPct: '100', lossStages: [],
    ingredients: [{ materialId: 1, quantity: '25', unit: 'g' as const }],
    costItems: [
      { category: 'labour' as const, description: 'Production', basis: 'fixed' as const, rate: '1000' },
      { category: 'testing' as const, description: 'Lab test', basis: 'step' as const, rate: '500', stepSize: '20' },
      { category: 'labour' as const, description: 'Filling', basis: 'per_hour' as const, rate: '300', hours: '0.1', hoursScale: true },
    ],
  };
  it('scales proportional quantities exactly once', () => {
    const r = calculateCosting({ recipe, batchQty: '50', materials: { 1: mat(1, '58.8681') } });
    expect(r.scaleFactor).toBe('50');
    // 25 g × 50 = 1.25 kg × 58.8681 = 73.585125 (NOT ×50 again)
    expect(r.sections.ingredients).toBe('73.585125');
    expect(r.lines[0].quantity).toBe('1.25');
  });
  it('fixed costs do not scale, step costs step, hourly scales when flagged', () => {
    const r = calculateCosting({ recipe, batchQty: '50', materials: { 1: mat(1, '58.8681') } });
    const byLabel = Object.fromEntries(r.lines.map((l) => [l.label, l.amount]));
    expect(byLabel['Production']).toBe('1000');
    expect(byLabel['Lab test']).toBe('1500'); // ceil(50/20)=3
    expect(byLabel['Filling']).toBe('1500'); // 0.1h×50×300
  });
  it('missing price is never zero and marks costing incomplete', () => {
    const r = calculateCosting({ recipe, batchQty: '50', materials: { 1: mat(1, null) } });
    expect(r.complete).toBe(false);
    expect(r.lines[0].status).toBe('missing');
    expect(r.lines[0].amount).toBeNull();
    expect(r.warnings.some((w) => w.code === 'missing_price')).toBe(true);
  });
  it('flags overhead/utilities double counting', () => {
    const r = calculateCosting({
      recipe: { ...recipe, costItems: [
        { category: 'overhead', description: 'OH', basis: 'percent', rate: '10', percentBase: 'production', includesUtilities: true },
        { category: 'utilities_equipment', description: 'Power', basis: 'fixed', rate: '50' },
      ] },
      batchQty: '1', materials: { 1: mat(1, '10') },
    });
    expect(r.warnings.some((w) => w.code === 'double_count')).toBe(true);
    expect(r.complete).toBe(false);
  });
  it('loss stages compound once into yield', () => {
    const r = calculateCosting({
      recipe: { ...recipe, costItems: [], yieldMode: 'stages', lossStages: [{ name: 'Filtration', pct: '10' }, { name: 'Filling', pct: '10' }] },
      batchQty: '100', materials: { 1: mat(1, '10') },
    });
    expect(r.yieldPct).toBe('81');
    expect(r.sellableQty).toBe('81');
  });
});

describe('packaging', () => {
  it('reproduces the strawberry export when interpreted as 1 L recipe, 50 L batch, 1 L fill, fixed labour', () => {
    const materials: Record<number, MaterialPrice> = {
      1: mat(1, '58.8681'), 2: mat(2, '138.44905'), 3: mat(3, '872.12'), 4: mat(4, '347.75785'), 5: mat(5, '610.484'),
      6: mat(6, '99.558', 'pc'), 7: mat(7, '30', 'pc'), 8: mat(8, '10', 'pc'),
    };
    const r = calculateCosting({
      recipe: {
        outputUnit: 'L', referenceBatchQty: '1', yieldMode: 'direct', yieldPct: '100', lossStages: [],
        ingredients: [
          { materialId: 1, quantity: '25', unit: 'g' }, { materialId: 2, quantity: '25', unit: 'g' },
          { materialId: 3, quantity: '1', unit: 'g' }, { materialId: 4, quantity: '100', unit: 'g' },
          { materialId: 5, quantity: '1', unit: 'g' },
        ],
        costItems: [{ category: 'labour', description: 'Production', basis: 'fixed', rate: '1000' }],
      },
      batchQty: '50',
      packaging: { name: '1 L in 1.5 L Tritan', fillQty: '1', fillUnit: 'L', components: [
        { materialId: 6, qtyPerPackage: '1' }, { materialId: 7, qtyPerPackage: '1' }, { materialId: 8, qtyPerPackage: '1' },
      ] },
      materials,
    });
    expect(new Decimal(r.sections.ingredients).toDecimalPlaces(2).toFixed(2)).toBe('2059.57');
    expect(r.packagingCost).toBe('6977.9');
    expect(r.packagedUnits).toBe('50');
    expect(new Decimal(r.totalBatchCost!).toDecimalPlaces(2).toFixed(2)).toBe('10037.47');
    expect(new Decimal(r.costPerPackage!).toDecimalPlaces(3).toFixed(3)).toBe('200.749');
  });
  it('excludes the unfilled remainder from sellable output', () => {
    const r = calculateCosting({
      ...simpleInput({}, '100'), batchQty: '100',
      packaging: { name: '3 L', fillQty: '3', fillUnit: 'L', components: [{ materialId: 2, qtyPerPackage: '1' }] },
      materials: { 1: mat(1, '100'), 2: mat(2, '5', 'pc') },
    });
    expect(r.packagedUnits).toBe('33');
    expect(r.fillRemainder).toBe('1');
    expect(r.sellableQty).toBe('99');
  });
});

describe('review fixes', () => {
  it('rejects ambiguous thousands separators but accepts decimal commas', async () => {
    const { dec } = await import('../shared/decimal');
    expect(dec('1,500')).toBeNull();
    expect(dec('1,234.5')).toBeNull();
    expect(dec('0,05')!.toFixed()).toBe('0.05');
    expect(dec('1 500')!.toFixed()).toBe('1500');
  });
  it('per-output cost lines use packaged sellable output, matching the denominator', () => {
    const r = calculateCosting({
      recipe: { outputUnit: 'L', referenceBatchQty: '100', yieldMode: 'direct', yieldPct: '100', lossStages: [], ingredients: [{ materialId: 1, quantity: '1', unit: 'kg' }],
        costItems: [{ category: 'other', description: 'Filling fee', basis: 'per_output_qty', rate: '2' }] },
      batchQty: '100', materials: { 1: mat(1, '10'), 2: mat(2, '1', 'pc') },
      packaging: { name: '3 L', fillQty: '3', fillUnit: 'L', components: [{ materialId: 2, qtyPerPackage: '1' }] },
    });
    expect(r.lines.find((l) => l.label === 'Filling fee')!.amount).toBe('198'); // 33 × 3 L × 2
  });
  it('flags actual packaged units exceeding actual output', () => {
    const r = calculateCosting({
      recipe: { outputUnit: 'L', referenceBatchQty: '10', yieldMode: 'direct', yieldPct: '100', lossStages: [], ingredients: [{ materialId: 1, quantity: '1', unit: 'kg' }], costItems: [] },
      batchQty: '10', materials: { 1: mat(1, '10'), 2: mat(2, '1', 'pc') }, actualOutputQty: '8', actualPackagedUnits: '10',
      packaging: { name: '1 L', fillQty: '1', fillUnit: 'L', components: [{ materialId: 2, qtyPerPackage: '1' }] },
    });
    expect(r.warnings.some((w) => w.code === 'units_exceed_output')).toBe(true);
    expect(r.complete).toBe(false);
  });
});
