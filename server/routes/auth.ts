import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createSession, destroySession, hashPassword, HttpError, requirePerm, SESSION_COOKIE, validatePassword, verifyPassword,
} from '../auth';
import { audit } from '../services';
import { ROLE_PERMISSIONS, ROLES } from '../../shared/permissions';
import { ROUNDING_RULES } from '../../shared/decimal';

const cookieOpts = (secure: boolean) => ({ path: '/', httpOnly: true, sameSite: 'strict' as const, secure, maxAge: 7 * 86400 });

export function registerAuthRoutes(app: FastifyInstance) {
  const db = app.db;

  app.get('/api/auth/me', async (req) => {
    const needsSetup = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n === 0;
    if (!req.user) return { user: null, needsSetup };
    return { user: req.user, permissions: ROLE_PERMISSIONS[req.user.role], needsSetup: false };
  });

  /** First-run only: create the first administrator when no users exist. */
  app.post('/api/auth/setup', async (req, reply) => {
    const body = z.object({ email: z.string().email(), name: z.string().min(1), password: z.string() }).parse(req.body);
    const pwErr = validatePassword(body.password);
    if (pwErr) throw new HttpError(400, pwErr);
    const id = db.tx(() => {
      if (db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n > 0) throw new HttpError(409, 'Setup has already been completed.');
      return db.run("INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, 'admin', ?)", body.email, body.name, hashPassword(body.password)).lastInsertRowid;
    });
    audit(db, { id, email: body.email, name: body.name, role: 'admin' }, 'user', id, 'create', 'First administrator created');
    reply.setCookie(SESSION_COOKIE, createSession(db, id), cookieOpts(app.secureCookies));
    return { ok: true };
  });

  const attempts = new Map<string, { n: number; until: number }>();
  app.post('/api/auth/login', async (req, reply) => {
    const body = z.object({ email: z.string(), password: z.string() }).parse(req.body);
    const key = `${req.ip}:${body.email.toLowerCase()}`;
    const a = attempts.get(key);
    if (a && a.n >= 5 && a.until > Date.now()) throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes.');
    const u = db.get<any>('SELECT * FROM users WHERE email = ? AND active = 1', body.email);
    if (!u || !verifyPassword(body.password, u.password_hash)) {
      attempts.set(key, { n: (a?.n ?? 0) + 1, until: Date.now() + 5 * 60_000 });
      throw new HttpError(401, 'Incorrect email or password.');
    }
    attempts.delete(key);
    reply.setCookie(SESSION_COOKIE, createSession(db, u.id), cookieOpts(app.secureCookies));
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    destroySession(db, req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post('/api/auth/password', async (req) => {
    const user = requirePerm(req);
    const body = z.object({ current: z.string(), next: z.string() }).parse(req.body);
    const u = db.get<any>('SELECT * FROM users WHERE id = ?', user.id);
    if (!verifyPassword(body.current, u.password_hash)) throw new HttpError(400, 'Current password is incorrect.');
    const err = validatePassword(body.next);
    if (err) throw new HttpError(400, err);
    db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(body.next), user.id);
    audit(db, user, 'user', user.id, 'password', 'Changed own password');
    return { ok: true };
  });

  // Users (admin)
  app.get('/api/users', async (req) => {
    requirePerm(req, 'users.manage');
    return db.all('SELECT id, email, name, role, active, created_at FROM users ORDER BY name');
  });
  const userBody = z.object({ email: z.string().email(), name: z.string().min(1), role: z.enum(ROLES as [string, ...string[]]), password: z.string().optional(), active: z.boolean().optional() });
  app.post('/api/users', async (req) => {
    const me = requirePerm(req, 'users.manage');
    const b = userBody.parse(req.body);
    const err = validatePassword(b.password);
    if (err) throw new HttpError(400, err);
    const id = db.run('INSERT INTO users (email, name, role, password_hash) VALUES (?,?,?,?)', b.email, b.name, b.role, hashPassword(b.password!)).lastInsertRowid;
    audit(db, me, 'user', id, 'create', `Created user ${b.email} (${b.role})`);
    return { id };
  });
  app.patch('/api/users/:id', async (req) => {
    const me = requirePerm(req, 'users.manage');
    const id = Number((req.params as any).id);
    const b = userBody.partial().parse(req.body);
    const before = db.get<any>('SELECT id, email, name, role, active FROM users WHERE id = ?', id);
    if (!before) throw new HttpError(404, 'User not found.');
    if (id === me.id && (b.role && b.role !== 'admin' || b.active === false)) throw new HttpError(400, 'You cannot remove your own administrator access.');
    if (b.password) {
      const err = validatePassword(b.password);
      if (err) throw new HttpError(400, err);
      db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(b.password), id);
      db.run('DELETE FROM sessions WHERE user_id = ?', id);
    }
    db.run('UPDATE users SET email = COALESCE(?, email), name = COALESCE(?, name), role = COALESCE(?, role), active = COALESCE(?, active) WHERE id = ?', b.email, b.name, b.role, b.active === undefined ? null : b.active ? 1 : 0, id);
    if (b.active === false || b.role) db.run('DELETE FROM sessions WHERE user_id = ?', id);
    audit(db, me, 'user', id, 'update', `Updated user ${before.email}`, before, { ...b, password: b.password ? '(changed)' : undefined });
    return { ok: true };
  });

  // Settings
  app.get('/api/settings', async (req) => {
    requirePerm(req);
    const rows = db.all<{ key: string; value: string }>('SELECT key, value FROM settings');
    return { settings: Object.fromEntries(rows.map((r) => [r.key, r.value])), roundingRules: ROUNDING_RULES, rolePermissions: ROLE_PERMISSIONS };
  });
  app.put('/api/settings', async (req) => {
    const me = requirePerm(req, 'settings.write');
    const b = z.record(z.string(), z.string()).parse(req.body);
    const before = Object.fromEntries(db.all<any>('SELECT key, value FROM settings').map((r) => [r.key, r.value]));
    db.tx(() => {
      for (const [k, v] of Object.entries(b)) {
        if (!(k in before)) continue;
        if (/_pct$/.test(k) && !/^\d+(\.\d+)?$/.test(v)) throw new HttpError(400, `${k} must be a number.`);
        db.run('UPDATE settings SET value = ? WHERE key = ?', v, k);
      }
    });
    audit(db, me, 'settings', null, 'update', 'Updated settings', before, b);
    return { ok: true };
  });

  app.get('/api/audit', async (req) => {
    requirePerm(req, 'audit.read');
    const q = req.query as any;
    const limit = Math.min(Number(q.limit) || 200, 1000);
    if (q.entity && q.entityId) return db.all('SELECT * FROM audit_log WHERE entity = ? AND entity_id = ? ORDER BY id DESC LIMIT ?', q.entity, Number(q.entityId), limit);
    return db.all('SELECT id, at, user_name, entity, entity_id, action, summary FROM audit_log ORDER BY id DESC LIMIT ?', limit);
  });
}
