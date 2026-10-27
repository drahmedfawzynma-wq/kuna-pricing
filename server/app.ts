import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fstatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import { DB } from './db';
import { HttpError, loadSessionUser, SESSION_COOKIE } from './auth';
import { registerAuthRoutes } from './routes/auth';
import { registerMaterialRoutes } from './routes/materials';
import { registerImportRoutes } from './routes/imports';
import { registerRecipeRoutes } from './routes/recipes';
import { registerCostingRoutes } from './routes/costings';
import { registerSalesRoutes } from './routes/sales';
import { registerBatchRoutes } from './routes/batches';
import { registerDashboardRoutes } from './routes/dashboard';
import { registerPartnerRoutes } from './routes/partners';
import { seedBase } from './seed';

export interface AppOptions {
  dbFile: string;
  staticDir?: string;
  secureCookies?: boolean;
  logger?: boolean;
}

declare module 'fastify' {
  interface FastifyInstance {
    db: DB;
    secureCookies: boolean;
  }
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 3_000_000 });
  const db = new DB(opts.dbFile);
  db.migrate();
  seedBase(db);
  app.decorate('db', db);
  app.decorate('secureCookies', !!opts.secureCookies);
  app.addHook('onClose', async () => db.close());

  await app.register(cookie);

  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    req.user = loadSessionUser(db, req.cookies[SESSION_COOKIE]);
    // CSRF defence: state-changing API calls must be JSON with our custom header.
    // Cross-site forms cannot set custom headers; cookies are SameSite=Strict as well.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-kuna-request'] !== '1') {
      throw new HttpError(403, 'Missing request header.');
    }
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message, details: err.details });
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: 'Invalid input: ' + err.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; '), details: err.issues });
    }
    if (typeof err?.message === 'string' && err.message.includes('UNIQUE constraint failed')) {
      return reply.status(409).send({ error: 'A record with this code or number already exists.' });
    }
    if (err?.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.message });
    req.log.error(err);
    if (!app.log.level || app.log.level === 'silent') console.error(err);
    return reply.status(500).send({ error: 'Unexpected server error. The change was not saved.' });
  });

  registerAuthRoutes(app);
  registerMaterialRoutes(app);
  registerImportRoutes(app);
  registerRecipeRoutes(app);
  registerCostingRoutes(app);
  registerSalesRoutes(app);
  registerBatchRoutes(app);
  registerPartnerRoutes(app);
  registerDashboardRoutes(app);

  app.all('/api/*', async () => {
    throw new HttpError(404, 'Not found.');
  });

  if (opts.staticDir && fs.existsSync(opts.staticDir)) {
    await app.register(fstatic, { root: path.resolve(opts.staticDir) });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'Not found.' });
      return reply.sendFile('index.html');
    });
  }
  return app;
}
