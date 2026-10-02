import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authRoutes } from './auth/routes.js';
import { loadSession, verifyCsrf } from './auth/session.js';
import type { Config } from './config.js';
import { HttpError, type AppCtx } from './context.js';
import { Envelope } from './crypto/envelope.js';
import type { Db } from './db/index.js';
import { demoLoginRoutes } from './demo/login.js';
import { adminRoutes } from './routes/admin.js';
import { customerRoutes } from './routes/customers.js';
import { reportRoutes } from './routes/reports.js';
import { scanRoutes } from './routes/scans.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Endpoints reachable without a session (they do their own checks). */
const PUBLIC_MUTATIONS = new Set(['/api/auth/breakglass', '/api/auth/demo']);

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
      ],
      censor: '[redacted]',
    },
    serializers: {
      // Never log one-time OAuth codes or consent state from query strings.
      req: (req: { method: string; url: string; ip?: string }) => ({
        method: req.method,
        url: /^\/(api\/auth\/callback|consent\/callback)/.test(req.url) ? req.url.split('?')[0] : req.url,
        ip: req.ip,
      }),
    },
  };
}

export async function buildApp(config: Config, db: Db): Promise<{ app: FastifyInstance; ctx: AppCtx }> {
  const app = Fastify({
    logger: loggerOptions(config),
    trustProxy: config.TRUST_PROXY === 'true' ? true : config.TRUST_PROXY === 'false' ? false : config.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
  });
  const ctx: AppCtx = { config, db, envelope: new Envelope(config.MASTER_KEY), log: app.log };
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

  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    await loadSession(ctx, req);
    if (MUTATING.has(req.method)) {
      // Defence in depth on top of SameSite=Strict cookies: same-origin requests only.
      const origin = req.headers.origin;
      const site = req.headers['sec-fetch-site'];
      if ((origin && origin !== appOrigin) || (site && site !== 'same-origin')) throw new HttpError(403, 'Cross-origin request blocked');
      const path = req.url.split('?')[0];
      if (!PUBLIC_MUTATIONS.has(path)) {
        if (!req.user) throw new HttpError(401, 'Not signed in');
        verifyCsrf(req);
      }
    }
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message });
    if (err.statusCode === 429) return reply.status(429).send({ error: 'Too many requests, slow down.' });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.code === 'FST_ERR_CTP_BODY_TOO_LARGE' ? 'Request too large' : 'Bad request' });
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: 'Internal error' });
  });

  app.get('/healthz', async () => {
    await db.execute(sql`select 1`);
    return { ok: true };
  });

  authRoutes(app, ctx);
  customerRoutes(app, ctx);
  scanRoutes(app, ctx);
  reportRoutes(app, ctx);
  adminRoutes(app, ctx);
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

  return { app, ctx };
}
