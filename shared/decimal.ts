import Decimal from 'decimal.js';

// High internal precision. Values are only rounded at the explicit points
// documented in ROUNDING_RULES (display, selling prices, quotation lines).
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };
export type Num = Decimal;

export const ROUNDING_RULES = [
  'All quantities, prices and costs are stored as exact decimal strings and calculated with 40 significant digits.',
  'Line costs and totals are calculated from unrounded values; they are rounded to 2 decimals (öre) only for display.',
  'Unit cost (per litre, kilogram or package) is kept unrounded when used for pricing.',
  'Selling prices calculated from a margin or markup are rounded half up to 2 decimals.',
  'Achieved margin and markup are calculated from the rounded selling price and the unrounded unit cost.',
  'Quotation line total = rounded unit price × quantity, rounded half up to 2 decimals. Quotation totals add rounded line totals.',
  'Exchange-rate conversions are not rounded before they enter a cost calculation.',
];

/** Parse user/DB input into a Decimal. Returns null for empty or invalid input. */
export function dec(v: unknown): Decimal | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Decimal) return v;
  if (typeof v === 'number') return Number.isFinite(v) ? new Decimal(v) : null;
  if (typeof v !== 'string') return null;
  let s = v.trim().replace(/[\s\u00a0\u202f]/g, '');
  if (s.includes(',')) {
    // A comma is accepted only as a decimal separator. "1,500" (thousands?) and "1,234.5" are ambiguous: rejected.
    if (s.includes('.') || (s.match(/,/g) ?? []).length > 1 || /^[-+]?\d{1,3},\d{3}$/.test(s)) return null;
    s = s.replace(',', '.');
  }
  if (s === '' || !/^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(s)) return null;
  try {
    return new Decimal(s);
  } catch {
    return null;
  }
}

export function isValidDecimal(v: unknown): boolean {
  return dec(v) !== null;
}

export function money(d: Decimal | null | undefined): string | null {
  return d ? d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2) : null;
}

/** Canonical storage string for a decimal (no exponent, trailing zeros trimmed). */
export function str(d: Decimal | null | undefined): string | null {
  if (!d) return null;
  const s = d.toFixed();
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}
