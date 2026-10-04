import { runSystem } from '@qs/checks';
import type { CheckOutcome } from '@qs/shared';
import { and, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { audit } from './audit.js';
import { purgeExpiredSessions } from './auth/session.js';
import type { AppCtx } from './context.js';
import { authStates, checkResults, credentials, scans, scanSystems } from './db/schema.js';
import { credAad, needsSecret, tenantBindingState } from './routes/scans.js';
import { applyRetention, settleOpenChecks } from './retention.js';
import { storeScanScore } from './scoring.js';
import { getRuntime, scannerEnv } from './settings/runtime.js';

export const WORKER_ID = `worker-${randomUUID().slice(0, 8)}`;
const POLL_MS = 2000;
const STALE_MINUTES = 10;
const OPEN = ['pending', 'running'] as const;

export const NOT_RUN = {
  cancelled: 'Not run: the scan was cancelled.',
  failed: 'Not run: the scan stopped because of an internal error.',
  completed: 'Not run: the check did not finish.',
} as const;

/** Claims the oldest queued scan atomically (safe with several workers). */
async function claim(ctx: AppCtx) {
  const r = await ctx.db.execute(sql`
    update scans set status = 'running', started_at = coalesce(started_at, now()), heartbeat_at = now(), worker_id = ${WORKER_ID}
    where id = (select id from scans where status = 'queued' order by queued_at limit 1 for update skip locked)
    returning id`);
  return (r.rows[0] as { id: string } | undefined)?.id;
}

type Final = 'completed' | 'cancelled' | 'failed';

/**
 * Final transition, only while this worker still owns the running scan (housekeeping or a cancel may have
 * changed it meanwhile). Returns false, and skips scoring, audit and retention, when the row was not ours.
 */
export async function finishScan(ctx: AppCtx, scanId: string, final: Final, opts: { keep?: string[]; actorId?: string | null; workerId?: string } = {}) {
  const upd = await ctx.db
    .update(scans)
    .set({ status: final, finishedAt: new Date() })
    .where(and(eq(scans.id, scanId), eq(scans.status, 'running'), eq(scans.workerId, opts.workerId ?? WORKER_ID)))
    .returning({ id: scans.id });
  if (!upd.length) {
    ctx.log.warn({ scanId, final }, 'scan state changed elsewhere, final write skipped');
    return false;
  }
  await settleOpenChecks(ctx, scanId, final === 'cancelled' ? 'na' : 'error', NOT_RUN[final]);
  await storeScanScore(ctx, scanId);
  await audit(ctx, null, `scan.${final}`, { type: 'scan', id: scanId }, undefined, { id: opts.actorId ?? '', email: 'worker' });
  await applyRetention(ctx, scanId, opts.keep);
  return true;
}

/** Runs one claimed scan. Returns without a final write when the worker is stopping (the scan is re-queued). */
async function runScan(ctx: AppCtx, scanId: string, isStopping: () => boolean) {
  const { db, envelope, log } = ctx;
  const scan = (await db.select().from(scans).where(eq(scans.id, scanId)).limit(1))[0];
  const systems = await db.select().from(scanSystems).where(eq(scanSystems.scanId, scanId));
  const pending = await db
    .select()
    .from(checkResults)
    .where(and(eq(checkResults.scanId, scanId), inArray(checkResults.status, [...OPEN])));
  log.info({ scanId, systems: systems.length, checks: pending.length }, 'scan started');

  let cancelled = false;
  let aborted = false;
  let lastCancelCheck = 0;
  const shouldStop = async () => {
    if (cancelled || aborted || isStopping()) return true;
    if (Date.now() - lastCancelCheck > 2000) {
      lastCancelCheck = Date.now();
      try {
        const s = (await db.select({ c: scans.cancelRequested, status: scans.status, w: scans.workerId }).from(scans).where(eq(scans.id, scanId)))[0];
        cancelled = Boolean(s?.c);
        // Someone else (housekeeping, another worker) took over: stop using the credentials.
        if (!s || s.status !== 'running' || s.w !== WORKER_ID) aborted = true;
        else await db.update(scans).set({ heartbeatAt: new Date() }).where(and(eq(scans.id, scanId), eq(scans.workerId, WORKER_ID)));
      } catch (e) {
        log.warn({ err: e, scanId }, 'cancel check failed');
      }
    }
    return cancelled || aborted || isStopping();
  };

  // Systems whose stored secret could not be decrypted keep it (no purge before the key is fixed).
  const keep: string[] = [];
  const settled = await Promise.allSettled(
    systems.map(async (sys) => {
      const checkIds = pending.filter((p) => p.systemId === sys.id).map((p) => p.checkId);
      if (!checkIds.length) return;
      // The configuration validated at Start (older scans have none frozen).
      const cfg = (sys.startedConfig ?? sys.config) as any;
      const failSystem = (summary: string) =>
        db
          .update(checkResults)
          .set({ status: 'error', summary, finishedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(checkResults.scanId, scanId), eq(checkResults.systemId, sys.id), inArray(checkResults.status, [...OPEN])));
      if (cfg.authMode === 'admin_consent') {
        const state = await tenantBindingState(db, cfg.tenantId, scan.customerId);
        if (state !== 'bound' || !cfg.consentGrantedAt) {
          await failSystem('Not run: admin consent for this Microsoft tenant is not linked to this organisation.');
          return;
        }
      }
      let secret: unknown = null;
      if (needsSecret(sys.provider, cfg.authMode)) {
        const c = (await db.select().from(credentials).where(eq(credentials.systemId, sys.id)).limit(1))[0];
        if (c) {
          try {
            secret = envelope.decryptJson(c.blob, credAad(scanId, sys.id));
          } catch {
            keep.push(sys.id);
            await failSystem('Stored credential could not be decrypted. An administrator must check the master key configuration.');
            return;
          }
          await db.update(credentials).set({ lastUsedAt: new Date() }).where(eq(credentials.systemId, sys.id));
        }
      }
      const where = (checkId: string) => and(eq(checkResults.scanId, scanId), eq(checkResults.systemId, sys.id), eq(checkResults.checkId, checkId));
      try {
        await runSystem({
          systemId: sys.id,
          provider: sys.provider,
          config: cfg,
          secret,
          checkIds,
          env: await scannerEnv(ctx),
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
      } finally {
        secret = null;
      }
    }).map((p) =>
      p.catch((e) => {
        // One failing system stops the others too, and the scan only finishes once every system has settled.
        aborted = true;
        throw e;
      }),
    ),
  );

  const errors = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  for (const e of errors) log.error({ err: e.reason, scanId }, 'scan system crashed');
  if (!errors.length && !cancelled && (aborted || isStopping())) {
    const open = await db
      .select({ id: checkResults.checkId })
      .from(checkResults)
      .where(and(eq(checkResults.scanId, scanId), inArray(checkResults.status, [...OPEN])))
      .limit(1);
    // Taken over elsewhere, or interrupted by a shutdown (re-queued by stopWorker): no final write here.
    if (aborted || open.length) return;
  }
  const final: Final = errors.length ? 'failed' : cancelled ? 'cancelled' : 'completed';
  await finishScan(ctx, scanId, final, { keep, actorId: scan.createdBy });
  log.info({ scanId, status: final }, 'scan finished');
}

const DAY_MS = 86_400_000;
let lastAuditPurge = 0;

/** Periodic housekeeping: expired credentials, stale scans, empty drafts, expired sessions, auth states and audit retention. */
export async function housekeeping(ctx: AppCtx) {
  const { db } = ctx;
  const expired = await db
    .delete(credentials)
    .where(and(isNotNull(credentials.expiresAt), lt(credentials.expiresAt, new Date())))
    .returning({ id: credentials.systemId });
  if (expired.length) await audit(ctx, null, 'credential.purge', undefined, { reason: 'expired', count: expired.length }, { id: '', email: 'worker' });

  const stale = await db
    .update(scans)
    .set({ status: 'failed', finishedAt: new Date(), workerId: null })
    .where(and(eq(scans.status, 'running'), lt(scans.heartbeatAt, new Date(Date.now() - STALE_MINUTES * 60_000))))
    .returning({ id: scans.id, createdBy: scans.createdBy });
  for (const s of stale) {
    await settleOpenChecks(ctx, s.id, 'error', 'Not run: the scan worker stopped unexpectedly.');
    await storeScanScore(ctx, s.id);
    await audit(ctx, null, 'scan.failed', { type: 'scan', id: s.id }, { reason: 'stale' }, { id: s.createdBy ?? '', email: 'worker' });
    await applyRetention(ctx, s.id);
  }

  // Drafts nobody added a system to (abandoned "New scan" clicks).
  await db.execute(sql`
    delete from scans where status = 'draft' and created_at < now() - interval '24 hours'
      and not exists (select 1 from scan_systems where scan_systems.scan_id = scans.id)`);
  // Rate-limit counters well past their window.
  await db.execute(sql`delete from login_attempts where updated_at < now() - interval '1 hour' and (locked_until is null or locked_until < now())`);
  await db.delete(authStates).where(lt(authStates.expiresAt, new Date()));
  await purgeExpiredSessions(ctx);

  if (Date.now() - lastAuditPurge > DAY_MS) {
    lastAuditPurge = Date.now();
    const months = (await getRuntime(ctx)).general.auditRetentionMonths;
    const r = await db.execute(sql`select audit_purge(make_interval(months => ${months}::int)) as n`);
    const n = Number((r.rows[0] as { n?: number } | undefined)?.n ?? 0);
    if (n) ctx.log.info({ purged: n, months }, 'audit log retention applied');
  }
}

/** Puts this worker's in-flight scans back in the queue (results so far kept, unfinished checks pending again). */
export async function requeueOwnScans(ctx: AppCtx, workerId = WORKER_ID) {
  const ids = await ctx.db
    .update(scans)
    .set({ status: 'queued', workerId: null, heartbeatAt: null })
    .where(and(eq(scans.status, 'running'), eq(scans.workerId, workerId)))
    .returning({ id: scans.id });
  for (const { id } of ids) {
    await ctx.db
      .update(checkResults)
      .set({ status: 'pending', startedAt: null, updatedAt: new Date() })
      .where(and(eq(checkResults.scanId, id), inArray(checkResults.status, [...OPEN])));
  }
  if (ids.length) ctx.log.info({ scans: ids.map((r) => r.id) }, 'in-flight scans re-queued');
  return ids.length;
}

/** Scans run in parallel up to this limit, so one long (or demo) scan cannot block the others. */
const MAX_CONCURRENT = 3;

/** Starts the worker loop; the returned function stops it, waiting at most `deadlineMs` for running scans. */
export function startWorker(ctx: AppCtx) {
  let stopping = false;
  const running = new Set<Promise<void>>();
  let lastHousekeeping = 0;
  let wake: (() => void) | null = null;

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
            const p: Promise<void> = runScan(ctx, id, () => stopping)
              .catch(async (e) => {
                ctx.log.error({ err: e, scanId: id }, 'scan crashed');
                await finishScan(ctx, id, 'failed').catch((err) => ctx.log.error({ err, scanId: id }, 'could not mark scan failed'));
              })
              .finally(() => running.delete(p));
            running.add(p);
            continue;
          }
        }
      } catch (e) {
        ctx.log.error({ err: e }, 'worker loop error');
      }
      await new Promise<void>((r) => {
        wake = r;
        setTimeout(r, POLL_MS);
      });
    }
  };
  ctx.log.info({ worker: WORKER_ID }, 'worker started');
  const looping = loop();
  return async (deadlineMs = 20_000) => {
    stopping = true;
    wake?.();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((r) => (timer = setTimeout(r, deadlineMs)));
    await Promise.race([Promise.allSettled([looping, ...running]), deadline]);
    clearTimeout(timer);
    await requeueOwnScans(ctx).catch((e) => ctx.log.error({ err: e }, 'could not re-queue scans'));
  };
}
