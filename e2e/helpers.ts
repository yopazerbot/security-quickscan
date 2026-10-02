import { expect, type Page } from '@playwright/test';
import { createHmac } from 'node:crypto';

function totp(b32: string) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let v = 0;
  const out: number[] = [];
  for (const c of b32.replace(/=+$/, '').toUpperCase()) {
    v = (v << 5) | A.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((v >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac('sha1', Buffer.from(out)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Set ${k} for the e2e tests (see scripts/e2e-local.sh)`);
  return v;
};

/** Break-glass login; waits for the next TOTP window if the current code was already used in this run. */
export async function loginAsAdmin(page: Page) {
  await page.goto('/login');
  await page.getByText('Emergency access').click();
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByLabel('Username').fill(env('E2E_BG_USER'));
    await page.getByLabel('Password').fill(env('E2E_BG_PASSWORD'));
    await page.getByLabel('Authenticator code').fill(totp(env('E2E_BG_TOTP_SECRET')));
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    try {
      await expect(page.getByText(/Welcome back/)).toBeVisible({ timeout: 5000 });
      return;
    } catch {
      await page.waitForTimeout(31_000 - (Date.now() % 30_000));
    }
  }
  throw new Error('Break-glass login failed');
}

export async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login\?signedOut=1/);
  await expect(page.getByText('You have been signed out.')).toBeVisible();
}
