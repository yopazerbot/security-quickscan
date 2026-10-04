import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authRoutes, localAccessToken } from './auth/routes.js';
import { loadSession, passwordChangePending, verifyCsrf } from './auth/session.js';
import { announceSetup, setupRoutes } from './auth/setup.js';
import { PASSWORD_CHANGE_REQUIRED } from '@qs/shared';
import { LOOPBACK, type Config } from './config.js';
import { HttpError, type AppCtx } from './context.js';
import { Envelope } from './crypto/envelope.js';
import type { Db } from './db/index.js';
import { demoLoginRoutes } from './demo/login.js';
import { adminRoutes } from './routes/admin.js';
import { customerRoutes } from './routes/customers.js';
import { reportRoutes } from './routes/reports.js';
import { scanRoutes } from './routes/scans.js';
import { settingsRoutes } from './routes/settings.js';
import { tenantRoutes } from './routes/tenants.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const inContainer = existsSync('/.dockerenv');
/** Endpoints reachable without a session (they do their own checks). */
const PUBLIC_MUTATIONS = new Set(['/api/auth/breakglass', '/api/auth/demo', '/api/auth/password/login', '/api/setup']);
/** All a password session with a temporary password may do until it is changed. */
const PASSWORD_CHANGE_ALLOWED = new Set(['/api/auth/me', '/api/auth/config', '/api/auth/logout', '/api/auth/password/change']);

function webDist() {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [resolve(here, '../../web/dist'), resolve(here, '../web/dist'), resolve(process.cwd(), 'apps/web/dist')]) {
    if (existsSync(resolve(p, 'index.html'))) return p;
  }
  return null;
}

export function loggerOptions(config: Config) {
  return {
    level: config.LOG_LEVEL,
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        'req.headers["x-csrf-token"]',
        'res.headers["set-cookie"]',
        '*.secret',
        '*.password',
        '*.token',
        '*.clientSecret',
        '*.secretAccessKey',
        '*.sessionToken',
        '*.currentPassword',
        '*.newPassword',
        '*.temporaryPassword',
      ],
      censor: '[redacted]',
    },
    serializers: {
      // Never log one-time OAuth codes, consent state or the setup token from query strings.
      req: (req: { method: string; url: string; ip?: string }) => ({
        method: req.method,
        url: /^\/(api\/auth\/callback|consent\/callback|setup)/.test(req.url) || req.url.includes('local_token=') || req.url.includes('token=') ? req.url.split('?')[0] : req.url,
        ip: req.ip,
      }),
    },
  };
}

/**
 * A hop count (never a blanket 'true') so a client cannot spoof its IP with X-Forwarded-For.
 * The default is 'false' (no proxy) and 1 on Railway (see config.ts); behind your own reverse proxy set TRUST_PROXY=1.
 * Fastify accepts a number at runtime; its typings only list string/boolean.
 */
function trustProxySetting(v: string): boolean | string {
  if (v === 'false' || v === '0') return false;
  const hops = v === 'true' ? 1 : /^\d+$/.test(v) ? Number(v) : null;
  return (hops ?? v) as unknown as string;
}

export async function buildApp(config: Config, db: Db): Promise<{ app: FastifyInstance; ctx: AppCtx }> {
  const app = Fastify({
    logger: loggerOptions(config),
    trustProxy: trustProxySetting(config.TRUST_PROXY),
    bodyLimit: 1024 * 1024,
  });
  const ctx: AppCtx = { config, db, envelope: new Envelope([config.MASTER_KEY, config.MASTER_KEY_PREVIOUS]), log: app.log };
  const appOrigin = new URL(config.APP_URL).origin;

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        styleSrcAttr: ["'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        ...(config.COOKIE_SECURE ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });

  app.addHook('onSend', async (req, reply) => {
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });

  /** Local mode has no login: only answer requests addressed to localhost (also blocks DNS rebinding). */
  const isLoopback = (hostHeader?: string) => {
    if (!hostHeader) return false;
    try {
      return LOOPBACK.has(new URL(`http://${hostHeader}`).hostname);
    } catch {
      return false;
    }
  };
  if (config.LOCAL_MODE) {
    app.addHook('onRequest', async (req, reply) => {
      if (req.url === '/healthz') return;
      if (!isLoopback(req.headers.host)) return reply.code(421).send({ error: 'Local mode only accepts requests to localhost' });
      // Outside a container the peer must be this machine too (in Docker it is the bridge gateway).
      if (!inContainer && !LOOPBACK_IPS.has(String(req.socket.remoteAddress ?? ''))) return reply.code(403).send({ error: 'Local mode only accepts connections from this machine' });
    });
    // Same host choice as main.ts: in a container local mode listens on all interfaces.
    const host = config.HOST ?? (inContainer ? '0.0.0.0' : '127.0.0.1');
    if (host === '0.0.0.0' || host === '::') {
      app.log.warn(
        `LOCAL_MODE has no login and listens on ${host}. Publish the port on 127.0.0.1 only (e.g. -p 127.0.0.1:${config.PORT}:${config.PORT}), never on all interfaces.`,
      );
    }
    if (config.LOCAL_REQUIRE_TOKEN) {
      // Like Jupyter: the first session needs this link; afterwards the browser keeps its session cookie.
      const link = `${config.APP_URL}/?local_token=${localAccessToken(ctx)}`;
      app.log.warn(`Open Security QuickScan with this one-time link: ${link}`);
      // Plain line as well, so it is easy to copy from `docker compose logs`.
      process.stderr.write(`\n  Security QuickScan is ready. Open this link to sign in:\n  ${link}\n\n`);
    }
  }

  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    await loadSession(ctx, req);
    if (MUTATING.has(req.method)) {
      // Defence in depth on top of SameSite=Strict cookies: same-origin requests only.
      const origin = req.headers.origin;
      const site = req.headers['sec-fetch-site'];
      // In local mode the published port may differ from APP_URL, so any localhost origin is accepted.
      const originOk = !origin || origin === appOrigin || (config.LOCAL_MODE && isLoopback(new URL(origin).host));
      if (!originOk || (site && site !== 'same-origin')) throw new HttpError(403, 'Cross-origin request blocked');
      const path = req.url.split('?')[0];
      if (!PUBLIC_MUTATIONS.has(path)) {
        if (!req.user) throw new HttpError(401, 'Not signed in');
        verifyCsrf(req);
      }
    }
    if (passwordChangePending(req) && !PASSWORD_CHANGE_ALLOWED.has(req.url.split('?')[0])) {
      throw new HttpError(403, 'Change your temporary password first', PASSWORD_CHANGE_REQUIRED);
    }
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.statusCode).send(err.code ? { error: err.message, code: err.code } : { error: err.message });
    if (err.statusCode === 429) {
      // Microsoft sign-in runs as full-page navigations: show the login page instead of raw JSON.
      if (req.method === 'GET' && /^\/api\/auth\/(login|callback)(\?|$)/.test(req.url)) return reply.redirect('/login?error=rate_limited');
      return reply.status(429).send({ error: 'Too many requests, slow down.' });
    }
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.code === 'FST_ERR_CTP_BODY_TOO_LARGE' ? 'Request too large' : 'Bad request' });
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: 'Internal error' });
  });

  app.get('/healthz', async () => {
    await db.execute(sql`select 1`);
    return { ok: true };
  });

  authRoutes(app, ctx);
  setupRoutes(app, ctx);
  settingsRoutes(app, ctx);
  customerRoutes(app, ctx);
  scanRoutes(app, ctx);
  reportRoutes(app, ctx);
  adminRoutes(app, ctx);
  tenantRoutes(app, ctx);
  demoLoginRoutes(app, ctx);

  const dist = webDist();
  if (dist) {
    await app.register(fastifyStatic, {
      root: dist,
      wildcard: false,
      index: false,
      setHeaders: (reply, path) => {
        reply.header('Cache-Control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.method !== 'GET' || !dist) return reply.status(404).send({ error: 'Not found' });
    reply.header('Cache-Control', 'no-cache');
    return reply.sendFile('index.html');
  });

  await announceSetup(ctx);
  return { app, ctx };
}
