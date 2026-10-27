import { Decimal, dec } from '../../shared/decimal';

const groupFmt = (s: string) => {
  const neg = s.startsWith('-');
  const [i, f] = s.replace('-', '').split('.');
  const grouped = i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${neg ? '−' : ''}${grouped}${f !== undefined ? `,${f}` : ''}`;
};

/** Money with fixed decimals, Swedish style grouping: 10 037,47 SEK */
export function sek(v: unknown, dp = 2, suffix = ' SEK'): string {
  const d = dec(v as any);
  if (!d) return '—';
  return groupFmt(d.toDecimalPlaces(dp, Decimal.ROUND_HALF_UP).toFixed(dp)) + suffix;
}

/** Number with up to `dp` decimals, trailing zeros removed. */
export function num(v: unknown, dp = 4): string {
  const d = dec(v as any);
  if (!d) return '—';
  const s = d.toDecimalPlaces(dp, Decimal.ROUND_HALF_UP).toFixed();
  return groupFmt(s);
}

export function pct(v: unknown, dp = 1): string {
  const d = dec(v as any);
  if (!d) return '—';
  return groupFmt(d.toDecimalPlaces(dp, Decimal.ROUND_HALF_UP).toFixed(dp)) + ' %';
}

export function qty(v: unknown, unit?: string | null, dp = 4): string {
  const n = num(v, dp);
  return n === '—' ? n : `${n}${unit ? ` ${unit}` : ''}`;
}

export function date(v: string | null | undefined): string {
  if (!v) return '—';
  return v.slice(0, 10);
}

export function dateTime(v: string | null | undefined): string {
  if (!v) return '—';
  return v.replace('T', ' ').slice(0, 16);
}

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const CATEGORY_LABELS: Record<string, string> = {
  raw: 'Raw material',
  water: 'Water',
  processing_aid: 'Processing aid',
  consumable: 'Consumable',
  packaging: 'Packaging',
};

export const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft', approved: 'Approved', archived: 'Archived', proposed: 'Proposed', superseded: 'Superseded', rejected: 'Rejected',
  cancelled: 'Cancelled', planned: 'Planned', in_production: 'In production', on_hold: 'On hold', released: 'Released',
  needs_review: 'Needs review', ok: 'Reviewed',
};
