import { DEFAULT_CONTEXT } from '@qs/shared';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb, runMigrations } from '../src/db/index.js';

describe('local mode configuration', () => {
  it('needs no login settings and generates a persistent master key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qs-'));
    const keyFile = join(dir, 'master.key');
    const a = loadConfig({ LOCAL_MODE: 'true', DATABASE_URL: 'postgres://x/y', KEY_FILE: keyFile } as any);
    expect(existsSync(keyFile)).toBe(true);
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(Buffer.from(a.MASTER_KEY, 'base64')).toHaveLength(32);
    expect(a.APP_URL).toBe('http://localhost:8080');
    expect(a.COOKIE_SECURE).toBe(false);
    const b = loadConfig({ LOCAL_MODE: 'true', DATABASE_URL: 'postgres://x/y', KEY_FILE: keyFile } as any);
    expect(b.MASTER_KEY).toBe(readFileSync(keyFile, 'utf8').trim());
  });

  it('works with the .env.example file as shipped (empty values are ignored)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qs-'));
    const example = Object.fromEntries(
      readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8')
        .split('\n')
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    const c = loadConfig({ ...example, LOCAL_MODE: 'true', DATABASE_URL: 'postgres://x/y', KEY_FILE: join(dir, 'k') } as any);
    expect(c.APP_URL).toBe('http://localhost:8080');
    expect(c.LOCAL_MODE).toBe(true);
  });

  it('refuses to run without login on a non-localhost address', () => {
    expect(() => loadConfig({ LOCAL_MODE: 'true', DATABASE_URL: 'postgres://x/y', APP_URL: 'https://scan.example.com', MASTER_KEY: Buffer.alloc(32).toString('base64') } as any)).toThrow(/localhost/);
  });
});

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)('local mode API', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qs-'));
  const config = loadConfig({ LOCAL_MODE: 'true', DATABASE_URL: url ?? 'postgres://skipped/none', KEY_FILE: join(dir, 'k'), LOG_LEVEL: 'fatal' } as any);
  const { db, pool } = createDb(config);
  let app: Awaited<ReturnType<typeof buildApp>>['app'];

  beforeAll(async () => {
    await runMigrations(db);
    ({ app } = await buildApp(config, db));
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('signs the local browser in automatically as administrator', async () => {
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { host: 'localhost:8080' } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.role).toBe('admin');
    expect(me.json().features.local).toBe(true);
    const cookie = String(me.headers['set-cookie']).split(';')[0];
    // Published on another port: any localhost origin is accepted, CSRF token still required.
    const created = await app.inject({
      method: 'POST',
      url: '/api/customers',
      headers: { host: '127.0.0.1:9000', origin: 'http://127.0.0.1:9000', cookie, 'x-csrf-token': me.json().csrfToken },
      payload: { name: 'Local Customer', context: DEFAULT_CONTEXT },
    });
    expect(created.statusCode).toBe(200);
    const noCsrf = await app.inject({ method: 'POST', url: '/api/customers', headers: { host: 'localhost:8080', origin: 'http://localhost:8080', cookie }, payload: { name: 'X', context: DEFAULT_CONTEXT } });
    expect(noCsrf.statusCode).toBe(403);
  });

  it('rejects requests addressed to other hosts (DNS rebinding)', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { host: 'evil.example:8080' } });
    expect(r.statusCode).toBe(421);
    const cross = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { host: 'localhost:8080', origin: 'https://evil.example' } });
    expect(cross.statusCode).toBe(403);
  });
});
