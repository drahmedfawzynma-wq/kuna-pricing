import type { DB } from './db';
import { hashPassword } from './auth';

export const DEFAULT_SETTINGS: Record<string, string> = {
  base_currency: 'SEK',
  default_vat_pct: '25',
  food_vat_pct: '12',
  show_vat_inclusive: '0',
  quotation_prefix: 'KQ',
  quotation_validity_days: '30',
  company_name: 'Kuna Group Sweden AB',
  company_address: '',
  quotation_terms: 'Prices exclude VAT unless stated. Delivery charges are shown separately.',
};

/** Idempotent base data: settings, Bluewater customer and (optionally) a first admin. */
export function seedBase(db: DB) {
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    db.run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', k, v);
  }
  if (!db.get("SELECT id FROM customers WHERE name = 'Bluewater Sweden'")) {
    db.run("INSERT INTO customers (name, currency, default_vat_pct, notes) VALUES ('Bluewater Sweden', 'SEK', '25', 'Primary customer. Edit contact details as needed.')");
  }
  const count = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n;
  const email = process.env.KUNA_ADMIN_EMAIL;
  const pw = process.env.KUNA_ADMIN_PASSWORD;
  if (count === 0 && email && pw) {
    db.run("INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, 'admin', ?)", email, process.env.KUNA_ADMIN_NAME || 'Administrator', hashPassword(pw));
  }
}
