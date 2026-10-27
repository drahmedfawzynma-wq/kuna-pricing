import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from './db';
import { can, type Permission, type Role } from '../shared/permissions';

export interface SessionUser {
  id: number;
  email: string;
  name: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

export const SESSION_COOKIE = 'kuna_session';
const SESSION_DAYS = 7;

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, saltHex, hashHex] = stored.split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  const expected = Buffer.from(hashHex, 'hex');
  return expected.length === hash.length && crypto.timingSafeEqual(expected, hash);
}

export function validatePassword(pw: unknown): string | null {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters.';
  return null;
}

const sha = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

export function createSession(db: DB, userId: number): string {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  db.run('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)', sha(token), userId, expires);
  db.run("DELETE FROM sessions WHERE expires_at < ?", new Date().toISOString());
  return token;
}

export function destroySession(db: DB, token: string | undefined) {
  if (token) db.run('DELETE FROM sessions WHERE id = ?', sha(token));
}

export function loadSessionUser(db: DB, token: string | undefined): SessionUser | undefined {
  if (!token) return undefined;
  const row = db.get<any>(
    `SELECT u.id, u.email, u.name, u.role, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND u.active = 1`, sha(token));
  if (!row || row.expires_at < new Date().toISOString()) return undefined;
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

/** Throws 401/403 unless the request user has every listed permission. */
export function requirePerm(req: FastifyRequest, ...perms: Permission[]): SessionUser {
  if (!req.user) throw new HttpError(401, 'Please sign in.');
  for (const p of perms) {
    if (!can(req.user.role, p)) throw new HttpError(403, `Your role (${req.user.role}) is not allowed to do this (${p}).`);
  }
  return req.user;
}

export function userCan(req: FastifyRequest, p: Permission) {
  return can(req.user?.role, p);
}

export type Reply = FastifyReply;
