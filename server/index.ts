import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 4310);
const host = process.env.HOST || '127.0.0.1';
const dbFile = process.env.KUNA_DB_FILE || path.join(os.homedir(), 'KunaData', 'kuna.db');

const app = await buildApp({
  dbFile,
  staticDir: path.join(root, 'dist'),
  secureCookies: process.env.KUNA_SECURE_COOKIES === '1',
  logger: process.env.KUNA_LOG === '1',
});

await app.listen({ port, host });
console.log(`Kuna Production & Pricing running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
console.log(`Database: ${dbFile}`);
