import { Decimal, dec, str } from './decimal';

export type PriceResult = { ok: true; value: string } | { ok: false; error: string };

const round2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/** Selling price for a target gross margin: unit cost ÷ (1 − margin). Rounded to 2 decimals. */
export function priceForMargin(unitCost: unknown, marginPct: unknown): PriceResult {
  const c = dec(unitCost);
  const m = dec(marginPct);
  if (!c || c.lte(0)) return { ok: false, error: 'Unit cost must be greater than zero.' };
  if (!m) return { ok: false, error: 'Enter a target gross margin.' };
  if (m.lt(0)) return { ok: false, error: 'Target gross margin cannot be negative.' };
  if (m.gte(100)) return { ok: false, error: 'Target gross margin must be below 100% (a 100% margin needs an infinite price).' };
  return { ok: true, value: round2(c.div(new Decimal(1).minus(m.div(100)))).toFixed(2) };
}

/** Selling price for a target markup: unit cost × (1 + markup). Rounded to 2 decimals. */
export function priceForMarkup(unitCost: unknown, markupPct: unknown): PriceResult {
  const c = dec(unitCost);
  const m = dec(markupPct);
  if (!c || c.lte(0)) return { ok: false, error: 'Unit cost must be greater than zero.' };
  if (!m) return { ok: false, error: 'Enter a markup.' };
  if (m.lt(0)) return { ok: false, error: 'Markup cannot be negative.' };
  return { ok: true, value: round2(c.times(new Decimal(1).plus(m.div(100)))).toFixed(2) };
}

/** Gross margin % = (price − cost) ÷ price × 100. */
export function marginPct(price: unknown, unitCost: unknown): PriceResult {
  const p = dec(price);
  const c = dec(unitCost);
  if (!p || p.lte(0)) return { ok: false, error: 'Selling price must be greater than zero.' };
  if (!c || c.lt(0)) return { ok: false, error: 'Unit cost is unavailable.' };
  return { ok: true, value: str(p.minus(c).div(p).times(100))! };
}

/** Markup % = (price − cost) ÷ cost × 100. */
export function markupPct(price: unknown, unitCost: unknown): PriceResult {
  const p = dec(price);
  const c = dec(unitCost);
  if (!p || p.lt(0)) return { ok: false, error: 'Selling price is invalid.' };
  if (!c || c.lte(0)) return { ok: false, error: 'Unit cost must be greater than zero.' };
  return { ok: true, value: str(p.minus(c).div(c).times(100))! };
}

export function grossProfit(price: unknown, unitCost: unknown): string | null {
  const p = dec(price);
  const c = dec(unitCost);
  return p && c ? str(p.minus(c)) : null;
}

export function withVat(amountExVat: unknown, vatPct: unknown): string | null {
  const a = dec(amountExVat);
  const v = dec(vatPct);
  if (!a || !v || v.lt(0)) return null;
  return round2(a.times(new Decimal(1).plus(v.div(100)))).toFixed(2);
}

export interface DownstreamInput {
  acquisitionCost: unknown; // what the downstream party pays Kuna per unit
  otherCostsPerUnit: unknown; // downstream's own explicit costs per unit (filling, logistics…)
  marginPct: unknown; // downstream gross margin target
  vatPct: unknown;
}

/** Suggested downstream (e.g. Bluewater retail) price. Needs explicit assumptions; never inferred. */
export function downstreamPrice(i: DownstreamInput): { ok: true; costBasis: string; exVat: string; incVat: string | null } | { ok: false; error: string } {
  const acq = dec(i.acquisitionCost);
  const other = dec(i.otherCostsPerUnit);
  if (!acq || acq.lte(0)) return { ok: false, error: 'Enter the downstream acquisition cost per unit (normally Kuna\'s selling price).' };
  if (!other || other.lt(0)) return { ok: false, error: 'Enter the downstream party\'s other costs per unit (0 if none, stated explicitly).' };
  const basis = acq.plus(other);
  const r = priceForMargin(basis, i.marginPct);
  if (!r.ok) return r;
  return { ok: true, costBasis: str(basis)!, exVat: r.value, incVat: withVat(r.value, i.vatPct) };
}

export function lineTotal(unitPrice: unknown, qty: unknown): string | null {
  const p = dec(unitPrice);
  const q = dec(qty);
  if (!p || !q) return null;
  return round2(round2(p).times(q)).toFixed(2);
}
