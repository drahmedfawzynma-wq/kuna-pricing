import { Decimal, dec, str } from './decimal';
import { convertQty, type BaseUnit, type QtyUnit } from './engine';

export interface PriceEntry {
  entryMode: 'per_unit' | 'per_pack';
  packQty?: string | null;
  packUnit?: QtyUnit | null;
  price: string | null;
  currency: string;
  exchangeRate: string | null;
  chargesSek?: string | null;
}

export type LandedResult = { ok: true; landed: string; formula: string } | { ok: false; error: string };

/**
 * Landed cost in SEK per base unit.
 * per_unit: price × rate + charges (charges are SEK per base unit)
 * per_pack: (price × rate + charges) ÷ pack quantity in base units (charges are SEK per pack)
 */
export function landedUnitPrice(e: PriceEntry, baseUnit: BaseUnit, densityKgPerL?: string | null): LandedResult {
  const price = dec(e.price);
  const rate = e.currency === 'SEK' ? new Decimal(1) : dec(e.exchangeRate);
  const charges = e.chargesSek == null || e.chargesSek === '' ? new Decimal(0) : dec(e.chargesSek);
  if (!price || price.lt(0)) return { ok: false, error: 'Enter a valid price.' };
  if (!rate || rate.lte(0)) return { ok: false, error: `Enter the exchange rate (SEK per 1 ${e.currency}).` };
  if (!charges || charges.lt(0)) return { ok: false, error: 'Charges must be zero or positive.' };
  const sek = price.times(rate);
  const rateText = e.currency === 'SEK' ? '' : ` × ${rate.toFixed()} SEK/${e.currency}`;
  if (e.entryMode === 'per_unit') {
    const landed = sek.plus(charges);
    return { ok: true, landed: str(landed)!, formula: `${price.toFixed()} ${e.currency}/${baseUnit}${rateText}${charges.gt(0) ? ` + ${charges.toFixed()} SEK charges` : ''} = ${landed.toDecimalPlaces(4).toFixed()} SEK/${baseUnit}` };
  }
  const pq = dec(e.packQty);
  if (!pq || pq.lte(0) || !e.packUnit) return { ok: false, error: 'Pack price needs a pack quantity and unit before a unit price can be calculated.' };
  const conv = convertQty(pq, e.packUnit, baseUnit, densityKgPerL);
  if (!conv.ok) return { ok: false, error: conv.error };
  const landed = sek.plus(charges).div(conv.value);
  return {
    ok: true,
    landed: str(landed)!,
    formula: `(${price.toFixed()} ${e.currency}/pack${rateText}${charges.gt(0) ? ` + ${charges.toFixed()} SEK charges` : ''}) ÷ ${conv.value.toFixed()} ${baseUnit} per pack = ${landed.toDecimalPlaces(4).toFixed()} SEK/${baseUnit}`,
  };
}
