/** Minimal RFC 4180 CSV parser and writer with spreadsheet formula-injection protection. */

export const MAX_CSV_BYTES = 2_000_000;

export function parseCsv(text: string): string[][] {
  if (text.length > MAX_CSV_BYTES) throw new Error('CSV file is too large (max 2 MB).');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  if (text.charCodeAt(0) === 0xfeff) i = 1; // BOM
  for (; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (quoted) throw new Error('CSV has an unterminated quoted field.');
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function cell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  // Neutralise values a spreadsheet would execute as formulas (but keep plain negative numbers).
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

export function rowsToObjects(rows: string[][]): { header: string[]; records: Record<string, string>[] } {
  const [header, ...rest] = rows;
  if (!header) return { header: [], records: [] };
  const h = header.map((x) => x.trim());
  const records = rest
    .filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) => Object.fromEntries(h.map((k, i) => [k, (r[i] ?? '').trim()])));
  return { header: h, records };
}
