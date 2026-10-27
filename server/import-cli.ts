/**
 * Import Batchworks exports straight into the database, with the same checks as the Imports screen.
 *   npm run import                 -> everything in sample-data/
 *   npm run import -- a.csv b.csv  -> specific files
 *
 * Materials are imported first (with their prices). Each recipe is imported as a draft with the
 * confirmed reading (quantities per 1 L reference batch, production batch = "Sellable units").
 * Values not in the files (water quantity, labour basis) stay "Needs review"; nothing is guessed.
 * Products that already exist are skipped, so running it twice is safe.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DB } from './db';
import { seedBase } from './seed';
import { analyzeBatchworksCosting, analyzeBatchworksMaterials, detectFormat } from './importers';
import { applyCosting, applyMaterials, validateDecisions } from './routes/imports';
import { audit } from './services';

const root = path.resolve(import.meta.dirname, '..');
const dbFile = process.env.KUNA_DB_FILE || path.join(os.homedir(), 'KunaData', 'kuna.db');
const args = process.argv.slice(2);
const files = (args.length ? args : fs.readdirSync(path.join(root, 'sample-data')).filter((f) => f.endsWith('.csv')).map((f) => path.join(root, 'sample-data', f)))
  .map((f) => ({ file: f, text: fs.readFileSync(f, 'utf8') }))
  .map((f) => ({ ...f, kind: detectFormat(f.text) }));

const db = new DB(dbFile);
db.migrate();
seedBase(db);
const admin = db.get<any>("SELECT id, email, name, role FROM users WHERE role = 'admin' AND active = 1 ORDER BY id LIMIT 1");
const me = admin ?? { id: 0, email: 'import', name: 'Import script', role: 'admin' };

const unknown = files.filter((f) => f.kind === 'unknown');
for (const u of unknown) console.log(`! Skipped ${path.basename(u.file)}: not a Batchworks export`);

const record = (kind: string, file: string, text: string, parsed: unknown) =>
  db.run("INSERT INTO import_batches (kind, filename, raw_text, parsed_json, status, created_by, applied_at) VALUES (?,?,?,?, 'applied', ?, datetime('now'))", kind, path.basename(file), text, JSON.stringify(parsed), me.id || null).lastInsertRowid;

console.log(`Database: ${dbFile}\n`);
for (const f of files.filter((x) => x.kind === 'batchworks_materials')) {
  const a = analyzeBatchworksMaterials(db, f.text);
  const out = db.tx(() => {
    const id = record(f.kind, f.file, f.text, a);
    const r = applyMaterials(db, me, id, a.proposals, f.kind);
    audit(db, me, 'import', id, 'apply', `Command-line import ${path.basename(f.file)}: ${JSON.stringify(r.summary)}`);
    return r.summary;
  });
  console.log(`Materials: ${out.created} created, ${out.priced} prices added, ${out.skipped} rows skipped (${a.proposals.filter((p) => p.needsReview).length} flagged for review)`);
}

for (const f of files.filter((x) => x.kind === 'batchworks_costing')) {
  const a = analyzeBatchworksCosting(db, f.text);
  const name = a.parsed.productName;
  if (a.existingProductId) { console.log(`- ${name}: already in the system, skipped`); continue; }
  const d = validateDecisions({ ...a.proposed, confirmed: true });
  const out = db.tx(() => {
    const id = record(f.kind, f.file, f.text, a);
    const r = applyCosting(db, me, id, a, d);
    audit(db, me, 'import', id, 'apply', `Command-line import ${path.basename(f.file)}`);
    return r.summary;
  });
  console.log(`+ ${name}: imported as draft v${out.versionNo} (1 L reference, ${d.defaultBatchQty} L production batch)${out.needsReview ? `\n    needs review: ${out.unresolved.join(' | ')}` : ''}`);
}

const missing = db.all<any>(`SELECT DISTINCT m.name FROM recipe_ingredients ri JOIN materials m ON m.id = ri.material_id
  WHERE NOT EXISTS (SELECT 1 FROM material_prices p WHERE p.material_id = m.id AND p.undated = 0)`);
console.log(`\nMaterials used in recipes without a price: ${missing.length ? missing.map((m) => m.name).join(', ') : 'none'}`);
db.close();
