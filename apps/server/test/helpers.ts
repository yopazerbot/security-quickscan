import { hash } from '@node-rs/argon2';
import type { AppCtx } from '../src/context.js';
import { settings } from '../src/db/schema.js';

export async function setDemoLoginForTest(ctx: AppCtx, pin: string) {
  const value = { enabled: true, pinHash: await hash(pin), updatedAt: new Date().toISOString(), updatedBy: 'test' };
  await ctx.db.insert(settings).values({ key: 'demo_login', value }).onConflictDoUpdate({ target: settings.key, set: { value } });
}
