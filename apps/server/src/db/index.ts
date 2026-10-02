import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Config } from '../config.js';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

export function createDb(config: Config) {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: 10,
    ssl: config.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
  });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

function migrationsFolder() {
  const here = dirname(fileURLToPath(import.meta.url));
  // Works from src/db (dev) and from dist/ (bundled build).
  for (const p of [resolve(here, '../../drizzle'), resolve(here, '../drizzle')]) if (existsSync(p)) return p;
  throw new Error('Migrations folder not found');
}

export async function runMigrations(db: Db) {
  await migrate(db, { migrationsFolder: migrationsFolder() });
}

export { schema };
