import { existsSync } from 'node:fs';
import pino from 'pino';
import { buildApp, loggerOptions } from './app.js';
import { loadConfig } from './config.js';
import { Envelope } from './crypto/envelope.js';
import { createDb, runMigrations } from './db/index.js';
import { seedDemo } from './demo/seed.js';
import { getRuntime } from './settings/runtime.js';
import { startWorker } from './worker.js';

async function main() {
  const config = loadConfig();
  const modeArg = process.argv.find((a) => a.startsWith('--mode='))?.split('=')[1];
  const mode = (modeArg as typeof config.MODE) ?? config.MODE;
  const { db, pool } = createDb(config);
  const log = pino(loggerOptions(config));

  await runMigrations(db);
  log.info({ mode }, 'database migrated');
  // The previous key stays readable during a master key rotation.
  const envelope = new Envelope([config.MASTER_KEY, config.MASTER_KEY_PREVIOUS]);
  // Demo mode from the app settings (or DEMO_MODE); switching it on in the settings seeds as well.
  if (mode !== 'worker') {
    const base = { config, db, envelope, log };
    if ((await getRuntime(base)).general.demoMode) await seedDemo(base).catch((e) => log.error({ err: e }, 'demo seeding failed'));
  }

  let stopWorker: ((deadlineMs?: number) => Promise<void>) | null = null;
  let close: (() => Promise<void>) | null = null;

  if (mode === 'api' || mode === 'all') {
    const { app, ctx } = await buildApp(config, db);
    // Local mode outside a container listens on loopback only; in Docker the port is published on 127.0.0.1.
    const host = config.HOST ?? (config.LOCAL_MODE && !existsSync('/.dockerenv') ? '127.0.0.1' : '0.0.0.0');
    await app.listen({ host, port: config.PORT });
    close = () => app.close();
    if (mode === 'all') stopWorker = startWorker(ctx);
  } else {
    stopWorker = startWorker({ config, db, envelope, log });
  }

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ sig }, 'shutting down');
    setTimeout(() => process.exit(1), 40_000).unref();
    try {
      // Worker first: running scans get up to 20 s, then go back to the queue for the next instance.
      await stopWorker?.(20_000);
      await close?.();
      await pool.end();
    } catch (e) {
      log.error({ err: e }, 'shutdown failed');
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
