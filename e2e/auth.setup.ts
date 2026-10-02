import { test as setup } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { loginAsAdmin } from './helpers';

// Logs in once and shares the session with all tests (avoids login rate limits and TOTP reuse).
setup('admin login', async ({ page }) => {
  await loginAsAdmin(page);
  mkdirSync('e2e/.auth', { recursive: true });
  await page.context().storageState({ path: 'e2e/.auth/admin.json' });
});
