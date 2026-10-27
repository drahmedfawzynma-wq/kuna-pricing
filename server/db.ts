import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(here, 'migrations');

export type Row = Record<string, any>;

export class DB {
  raw: DatabaseSync;
  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA foreign_keys = ON;');
    if (file !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  }
  all<T = Row>(sql: string, ...params: any[]): T[] {
    return this.raw.prepare(sql).all(...params.map(norm)) as T[];
  }
  get<T = Row>(sql: string, ...params: any[]): T | undefined {
    return this.raw.prepare(sql).get(...params.map(norm)) as T | undefined;
  }
  run(sql: string, ...params: any[]): { lastInsertRowid: number; changes: number } {
    const r = this.raw.prepare(sql).run(...params.map(norm));
    return { lastInsertRowid: Number(r.lastInsertRowid), changes: Number(r.changes) };
  }
  tx<T>(fn: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    }
  }
  migrate(): string[] {
    this.raw.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime(\'now\')))');
    const done = new Set(this.all<{ name: string }>('SELECT name FROM schema_migrations').map((r) => r.name));
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const applied: string[] = [];
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
      this.tx(() => {
        this.raw.exec(sql);
        this.run('INSERT INTO schema_migrations (name) VALUES (?)', f);
      });
      applied.push(f);
    }
    return applied;
  }
  close() {
    this.raw.close();
  }
}

function norm(v: any) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

export function nowIso() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
export function today() {
  return new Date().toISOString().slice(0, 10);
}
