import { and, eq, lt, or, sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '@qs/shared';
import type { AppCtx, SessionUser } from '../context.js';
import { forbidden, HttpError } from '../context.js';
import { randomToken, safeEqual, sha256 } from '../crypto/envelope.js';
import { customerAssignments, sessions, users } from '../db/schema.js';

export const cookieName = (ctx: AppCtx) => (ctx.config.COOKIE_SECURE ? '__Host-qs_session' : 'qs_session');

export async function createSession(ctx: AppCtx, req: FastifyRequest, reply: FastifyReply, userId: string, authMethod: string) {
  // Rotate: any session presented with this request is discarded.
  await destroySession(ctx, req, reply);
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + ctx.config.SESSION_MAX_HOURS * 3600_000);
  await ctx.db.insert(sessions).values({
    idHash: sha256(token),
    userId,
    csrfToken: randomToken(24),
    authMethod,
    ip: req.ip,
    userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300),
    expiresAt,
  });
  await ctx.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
  reply.setCookie(cookieName(ctx), token, {
    path: '/',
    httpOnly: true,
    secure: ctx.config.COOKIE_SECURE,
    sameSite: 'strict',
    expires: expiresAt,
  });
  return token;
}

export async function destroySession(ctx: AppCtx, req: FastifyRequest, reply: FastifyReply) {
  const token = req.cookies[cookieName(ctx)];
  if (token) await ctx.db.delete(sessions).where(eq(sessions.idHash, sha256(token)));
  reply.clearCookie(cookieName(ctx), { path: '/', secure: ctx.config.COOKIE_SECURE, httpOnly: true, sameSite: 'strict' });
}

/** onRequest hook: resolves the session cookie into req.user, enforcing idle and absolute timeouts. */
export async function loadSession(ctx: AppCtx, req: FastifyRequest) {
  const token = req.cookies[cookieName(ctx)];
  if (!token || token.length > 100) return;
  const idHash = sha256(token);
  const rows = await ctx.db
    .select({ s: sessions, u: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.idHash, idHash))
    .limit(1);
  const row = rows[0];
  if (!row) return;
  const now = Date.now();
  const idleMs = ctx.config.SESSION_IDLE_MINUTES * 60_000;
  // Demo visitor sessions end as soon as demo mode is switched off.
  if (row.s.expiresAt.getTime() < now || row.s.lastSeenAt.getTime() < now - idleMs || !row.u.active || (row.u.isDemo && !ctx.config.DEMO_MODE)) {
    await ctx.db.delete(sessions).where(eq(sessions.idHash, idHash));
    return;
  }
  if (now - row.s.lastSeenAt.getTime() > 30_000) {
    await ctx.db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.idHash, idHash));
  }
  req.user = {
    id: row.u.id,
    email: row.u.email,
    name: row.u.name,
    role: row.u.role,
    allCustomers: row.u.allCustomers,
    isBreakglass: row.u.isBreakglass,
    isDemo: row.u.isDemo,
  };
  req.session = { idHash, csrfToken: row.s.csrfToken, authMethod: row.s.authMethod, expiresAt: row.s.expiresAt };
}

export function verifyCsrf(req: FastifyRequest) {
  const header = req.headers['x-csrf-token'];
  if (!req.session || typeof header !== 'string' || !safeEqual(header, req.session.csrfToken)) {
    throw new HttpError(403, 'Invalid CSRF token');
  }
}

export async function purgeExpiredSessions(ctx: AppCtx) {
  const idle = new Date(Date.now() - ctx.config.SESSION_IDLE_MINUTES * 60_000);
  await ctx.db.delete(sessions).where(or(lt(sessions.expiresAt, new Date()), lt(sessions.lastSeenAt, idle)));
}

export function requireUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw new HttpError(401, 'Not signed in');
  return req.user;
}

export function requireRole(req: FastifyRequest, ...roles: Role[]): SessionUser {
  const u = requireUser(req);
  if (!roles.includes(u.role)) throw forbidden();
  return u;
}

export async function canAccessCustomer(ctx: AppCtx, user: SessionUser, customerId: string): Promise<boolean> {
  if (user.role === 'admin' || user.allCustomers) return true;
  const r = await ctx.db
    .select({ one: sql`1` })
    .from(customerAssignments)
    .where(and(eq(customerAssignments.userId, user.id), eq(customerAssignments.customerId, customerId)))
    .limit(1);
  return r.length > 0;
}

/** Throws 404 (not 403) so the existence of other customers is not revealed. */
export async function assertCustomerAccess(ctx: AppCtx, req: FastifyRequest, customerId: string, write = false) {
  const u = requireUser(req);
  if (write && u.role === 'viewer') throw forbidden('Read-only account');
  if (!(await canAccessCustomer(ctx, u, customerId))) throw new HttpError(404, 'Not found');
  return u;
}

/** Re-validates a session during long-lived requests (SSE): still present, not expired, user active. */
export async function sessionStillValid(ctx: AppCtx, idHash: string): Promise<boolean> {
  const r = await ctx.db
    .select({ exp: sessions.expiresAt, active: users.active })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.idHash, idHash))
    .limit(1);
  return Boolean(r[0] && r[0].active && r[0].exp.getTime() > Date.now());
}
