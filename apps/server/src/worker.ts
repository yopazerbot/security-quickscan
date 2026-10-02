import { runSystem } from '@qs/checks';
import type { CheckOutcome } from '@qs/shared';
import { and, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { audit } from './audit.js';
import { purgeExpiredSessions } from './auth/session.js';
import { scannerEnv } from './config.js';
import type { AppCtx } from './context.js';
import { authStates, checkResults, credentials, scans, scanSystems } from './db/schema.js';
import { credAad, needsSecret } from './routes/scans.js';
import { applyRetention } from './retention.js';
import { storeScanScore } from './scoring.js';

const WORKER_ID = `worker-${randomUUID().slice(0, 8)}`;
const POLL_MS = 2000;
const STALE_MINUTES = 10;

/** Claims the oldest queued scan atomically (safe with several workers). */
async function claim(ctx: AppCtx) {
  const r = await ctx.db.execute(sql`
    update scans set status = 'running', started_at = now(), heartbeat_at = now(), worker_id = ${WORKER_ID}
    where id = (select id from scans where status = 'queued' order by queued_at limit 1 for update skip locked)
    returning id`);
  return (r.rows[0] as { id: string } | undefined)?.id;
}

async function runScan(ctx: AppCtx, scanId: string) {
  const { db, envelope, log } = ctx;
  const scan = (await db.select().from(scans).where(eq(scans.id, scanId)).limit(1))[0];
  const systems = await db.select().from(scanSystems).where(eq(scanSystems.scanId, scanId));
  const pending = await db.select().from(checkResults).where(eq(checkResults.scanId, scanId));
  log.info({ scanId, systems: systems.length, checks: pending.length }, 'scan started');

  let cancelled = false;
  let lastCancelCheck = 0;
  const shouldStop = async () => {
    if (cancelled) return true;
    if (Date.now() - lastCancelCheck > 2000) {
      lastCancelCheck = Date.now();
      const s = (await db.select({ c: scans.cancelRequested }).from(scans).where(eq(scans.id, scanId)))[0];
      cancelled = Boolean(s?.c);
      await db.update(scans).set({ heartbeatAt: new Date() }).where(eq(scans.id, scanId));
    }
    return cancelled;
  };

  await Promise.all(
    systems.map(async (sys) => {
      const checkIds = pending.filter((p) => p.systemId === sys.id).map((p) => p.checkId);
      if (!checkIds.length) return;
      const cfg = sys.config as any;
      let secret: unknown = null;
      if (needsSecret(sys.provider, cfg.authMode)) {
        const c = (await db.select().from(credentials).where(eq(credentials.systemId, sys.id)).limit(1))[0];
        if (c) {
          secret = envelope.decryptJson(c.blob, credAad(scanId, sys.id));
          await db.update(credentials).set({ lastUsedAt: new Date() }).where(eq(credentials.systemId, sys.id));
        }
      }
      const where = (checkId: string) => and(eq(checkResults.scanId, scanId), eq(checkResults.systemId, sys.id), eq(checkResults.checkId, checkId));
      await runSystem({
        systemId: sys.id,
        provider: sys.provider,
        config: cfg,
        secret,
        checkIds,
        env: scannerEnv(ctx.config),
        shouldStop,
        onStart: async (checkId) => {
          await db.update(checkResults).set({ status: 'running', startedAt: new Date(), updatedAt: new Date() }).where(where(checkId));
        },
        onResult: async (checkId, o: CheckOutcome) => {
          await db
            .update(checkResults)
            .set({ status: o.status, summary: o.summary.slice(0, 2000), resources: o.resources ?? [], evidence: o.evidence ?? null, finishedAt: new Date(), updatedAt: new Date() })
            .where(where(checkId));
        },
      });
      secret = null;
    }),
  );

  const final = cancelled ? 'cancelled' : 'completed';
  if (cancelled) {
    await db
      .update(checkResults)
      .set({ status: 'na', summary: 'Not run: scan was cancelled.', updatedAt: new Date() })
      .where(and(eq(checkResults.scanId, scanId), inArray(checkResults.status, ['pending', 'running'])));
  }
  await storeScanScore(ctx, scanId);
  await db.update(scans).set({ status: final, finishedAt: new Date() }).where(eq(scans.id, scanId));
  await audit(ctx, null, `scan.${final}`, { type: 'scan', id: scanId }, undefined, { id: scan.createdBy ?? '', email: 'worker' });
  await applyRetention(ctx, scanId);
  log.info({ scanId, status: final }, 'scan finished');
}

/** Periodic housekeeping: expired credentials, stale scans, expired sessions and auth states. */
async function housekeeping(ctx: AppCtx) {
  const { db } = ctx;
  const expired = await db
    .delete(credentials)
    .where(and(isNotNull(credentials.expiresAt), lt(credentials.expiresAt, new Date())))
    .returning({ id: credentials.systemId });
  if (expired.length) await audit(ctx, null, 'credential.purge', undefined, { reason: 'expired', count: expired.length }, { id: '', email: 'worker' });

  const stale = await db
    .update(scans)
    .set({ status: 'failed', finishedAt: new Date() })
    .where(and(eq(scans.status, 'running'), lt(scans.heartbeatAt, new Date(Date.now() - STALE_MINUTES * 60_000))))
    .returning({ id: scans.id });
  for (const s of stale) {
    await db
      .update(checkResults)
      .set({ status: 'error', summary: 'Scan worker stopped unexpectedly.', updatedAt: new Date() })
      .where(and(eq(checkResults.scanId, s.id), inArray(checkResults.status, ['pending', 'running'])));
    await applyRetention(ctx, s.id);
  }
  await db.delete(authStates).where(lt(authStates.expiresAt, new Date()));
  await purgeExpiredSessions(ctx);
}

/** Scans run in parallel up to this limit, so one long (or demo) scan cannot block the others. */
const MAX_CONCURRENT = 3;

export function startWorker(ctx: AppCtx) {
  let stopping = false;
  const running = new Set<Promise<void>>();
  let lastHousekeeping = 0;

  const loop = async () => {
    while (!stopping) {
      try {
        if (Date.now() - lastHousekeeping > 60_000) {
          lastHousekeeping = Date.now();
          await housekeeping(ctx);
        }
        if (running.size < MAX_CONCURRENT) {
          const id = await claim(ctx);
          if (id) {
            const p: Promise<void> = runScan(ctx, id)
              .catch(async (e) => {
                ctx.log.error({ err: e, scanId: id }, 'scan crashed');
                await ctx.db.update(scans).set({ status: 'failed', finishedAt: new Date() }).where(eq(scans.id, id));
                await applyRetention(ctx, id).catch(() => undefined);
              })
              .finally(() => running.delete(p));
            running.add(p);
            continue;
          }
        }
      } catch (e) {
        ctx.log.error({ err: e }, 'worker loop error');
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  };
  ctx.log.info({ worker: WORKER_ID }, 'worker started');
  void loop();
  return async () => {
    stopping = true;
    await Promise.allSettled([...running]);
  };
}
