import pino from 'pino';
import { buildApp, loggerOptions } from './app.js';
import { loadConfig } from './config.js';
import { Envelope } from './crypto/envelope.js';
import { createDb, runMigrations } from './db/index.js';
import { startWorker } from './worker.js';

async function main() {
  const config = loadConfig();
  const modeArg = process.argv.find((a) => a.startsWith('--mode='))?.split('=')[1];
  const mode = (modeArg as typeof config.MODE) ?? config.MODE;
  const { db, pool } = createDb(config);
  const log = pino(loggerOptions(config));

  await runMigrations(db);
  log.info({ mode }, 'database migrated');

  let stopWorker: (() => Promise<void>) | null = null;
  let close: (() => Promise<void>) | null = null;

  if (mode === 'api' || mode === 'all') {
    const { app, ctx } = await buildApp(config, db);
    await app.listen({ host: '0.0.0.0', port: config.PORT });
    close = () => app.close();
    if (mode === 'all') stopWorker = startWorker(ctx);
  } else {
    stopWorker = startWorker({ config, db, envelope: new Envelope(config.MASTER_KEY), log });
  }

  const shutdown = async (sig: string) => {
    log.info({ sig }, 'shutting down');
    await close?.();
    await stopWorker?.();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
