/**
 * Admin command line:
 *   npm run backup                      -> consistent copy of the database (default ~/KunaData/backups)
 *   npm run user -- create <email> <name> <role> <password>
 *   npm run user -- reset-password <email> <password>
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { DB } from './db';
import { hashPassword, validatePassword } from './auth';
import { ROLES } from '../shared/permissions';

const dbFile = process.env.KUNA_DB_FILE || path.join(os.homedir(), 'KunaData', 'kuna.db');
const [cmd, ...args] = process.argv.slice(2);
const db = new DB(dbFile);
db.migrate();

if (cmd === 'backup') {
  const dir = process.env.KUNA_BACKUP_DIR || path.join(os.homedir(), 'KunaData', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `kuna-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23)}.db`);
  db.raw.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  console.log(`Backup written: ${file}`);
  // Keep the newest backups only (default 90).
  const keep = Number(process.env.KUNA_BACKUP_KEEP || 90);
  const old = fs.readdirSync(dir).filter((f) => /^kuna-.*\.db$/.test(f)).sort().reverse().slice(keep);
  for (const f of old) fs.unlinkSync(path.join(dir, f));
  if (old.length) console.log(`Removed ${old.length} old backup(s).`);
} else if (cmd === 'user' && args[0] === 'create') {
  const [, email, name, role, password] = args;
  if (!email || !name || !ROLES.includes(role as any) || validatePassword(password)) {
    console.error(`Usage: npm run user -- create <email> "<name>" <${ROLES.join('|')}> <password (10+ chars)>`);
    process.exit(1);
  }
  db.run('INSERT INTO users (email, name, role, password_hash) VALUES (?,?,?,?)', email, name, role, hashPassword(password));
  console.log(`Created ${role} user ${email}`);
} else if (cmd === 'user' && args[0] === 'reset-password') {
  const [, email, password] = args;
  const err = validatePassword(password);
  if (!email || err) { console.error(err ?? 'Usage: npm run user -- reset-password <email> <password>'); process.exit(1); }
  const r = db.run('UPDATE users SET password_hash = ? WHERE email = ?', hashPassword(password), email);
  db.run('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ?)', email);
  console.log(r.changes ? `Password reset for ${email}` : `No user ${email}`);
} else {
  console.log('Commands: backup | user create <email> <name> <role> <password> | user reset-password <email> <password>');
}
db.close();
