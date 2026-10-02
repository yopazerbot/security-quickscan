import { expect, test } from '@playwright/test';
import { signOut } from './helpers';

const DEMO = 'Noordkust Logistics NV';
const DEMO_PIN = '482913';

test.describe.configure({ mode: 'serial' });

test('admin sees the seeded demo customer with history and reports', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Customers', exact: true }).click();
  await page.getByText(DEMO).click();
  await expect(page.getByRole('heading', { name: 'Score trend' })).toBeVisible();
  await expect(page.getByText('Baseline quick scan')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Triaged findings' })).toBeVisible();

  await page.getByText('Follow-up quick scan').click();
  await expect(page.getByRole('heading', { name: 'Security quick scan report' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'ISO/IEC 27001:2022 Annex A' })).toBeVisible();
  await expect(page.getByText(/Since the previous scan/)).toBeVisible();
  await expect(page.getByRole('heading', { name: /Top risks/ })).toBeVisible();
});

test('run the prepared draft scan end to end and download the exports', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Customers', exact: true }).click();
  await page.getByText(DEMO).click();
  await page.getByText('Quarterly quick scan (ready to run)').click();
  await expect(page.getByText('Customer authorisation')).toBeVisible();
  await page.getByRole('button', { name: 'Start scan' }).click();
  await expect(page).toHaveURL(/\/progress/);
  await expect(page.getByRole('button', { name: 'View report' })).toBeVisible({ timeout: 150_000 });
  await page.getByRole('button', { name: 'View report' }).click();
  await expect(page.getByRole('heading', { name: 'Security quick scan report' })).toBeVisible();

  for (const label of ['PDF report', 'Findings CSV', 'ISO controls CSV']) {
    const dl = page.waitForEvent('download');
    await page.getByRole('button', { name: label }).click();
    const file = await dl;
    const path = await file.path();
    expect(path, label).toBeTruthy();
    const { statSync } = await import('node:fs');
    expect(statSync(path!).size, label).toBeGreaterThan(500);
  }

  // Triage a finding from the report.
  const finding = page.getByTestId('finding').first();
  await finding.getByRole('button').first().click();
  await finding.getByRole('combobox').selectOption('accepted');
  await finding.getByPlaceholder('Note (shown in the report)').fill('Accepted in e2e test');
  await finding.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('finding').getByText('Risk accepted').first()).toBeVisible();
});

test('new customer through the full wizard with demo systems', async ({ page }) => {
  await page.goto('/');
  await page.goto('/customers/new');
  await page.getByLabel('Customer name').fill(`E2E Customer ${Date.now()}`);
  await page.getByRole('button', { name: 'Create customer' }).click();
  await page.getByRole('button', { name: 'New scan' }).click();
  await expect(page.getByText('Confirm the customer context')).toBeVisible();
  await page.getByRole('button', { name: 'Save and continue' }).click();
  for (const p of ['Microsoft 365 / Entra ID', 'GitHub']) {
    await page.locator('button', { hasText: p }).first().click();
    await page.getByRole('button', { name: /Demo \(simulated\)/ }).click();
    if (p === 'GitHub') await page.getByLabel('Organisation').fill('e2e-org');
    await page.getByRole('button', { name: 'Add system' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
  }
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Credential retention')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Evaluation criteria')).toBeVisible();
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await page.getByLabel('Authorised by (name)').fill('Test Person');
  await page.getByLabel('Role / title').fill('CTO');
  await page.getByLabel('E-mail').fill('cto@example.com');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Start scan' }).click();
  await expect(page.getByRole('button', { name: 'View report' })).toBeVisible({ timeout: 150_000 });
});

test('reset demo data restores the original demo customer', async ({ page }) => {
  await page.goto('/');
  await page.goto('/admin/settings');
  await page.getByRole('button', { name: 'Reset demo data' }).click();
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(page.getByText('Demo data was reset.')).toBeVisible();
  await page.getByRole('link', { name: 'Customers', exact: true }).click();
  await page.getByText(DEMO).click();
  await expect(page.getByText('Quarterly quick scan (ready to run)')).toBeVisible();
});

// Runs last: signing out ends the shared admin session.
test('demo PIN login: admin enables it, visitor only sees demo data, sign out works', async ({ page }) => {
  await page.goto('/');
  await page.goto('/admin/settings');
  await page.getByLabel(/PIN/).fill(DEMO_PIN);
  await page.getByRole('button', { name: /Set PIN and enable|Change PIN/ }).click();
  await expect(page.getByText(/PIN saved/)).toBeVisible();
  await signOut(page);

  await page.getByLabel('Demo PIN').fill('000000');
  await page.getByRole('button', { name: 'Enter demo' }).click();
  await expect(page.getByText('Invalid PIN')).toBeVisible();
  await page.getByLabel('Demo PIN').fill(DEMO_PIN);
  await page.getByRole('button', { name: 'Enter demo' }).click();
  await expect(page.getByText(/Demo session/)).toBeVisible();
  await page.getByRole('link', { name: 'Customers', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Customers' })).toBeVisible();
  await expect(page.getByText(DEMO).first()).toBeVisible();
  await expect(page.getByText(/E2E Customer/)).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Users', exact: true })).toHaveCount(0);
  await signOut(page);
});
