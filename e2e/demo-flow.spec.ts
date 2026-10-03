import { expect, test } from '@playwright/test';
import { openDemoOrganisation, signOut } from './helpers';

const DEMO = 'Noordkust Logistics NV';
const DEMO_PIN = '48291357';

test.describe.configure({ mode: 'serial' });

test('admin sees the seeded demo organisation with history and reports', async ({ page }) => {
  await page.goto('/');
  await openDemoOrganisation(page);
  await expect(page.getByRole('heading', { name: 'Score trend' })).toBeVisible();
  await expect(page.getByText('Baseline quick scan')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Triaged findings' })).toBeVisible();
  // Admins manage access to every organisation, including ones they do not own.
  await expect(page.getByRole('heading', { name: 'Access', exact: true })).toBeVisible();
  await expect(page.getByLabel('Share by email address')).toBeVisible();

  await page.getByText('Follow-up quick scan').click();
  await expect(page.getByRole('heading', { name: 'Cloud Security Quick Scan Report' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'ISO/IEC 27001:2022 Annex A' })).toBeVisible();
  await expect(page.getByText(/Since the previous scan/)).toBeVisible();
  await expect(page.getByRole('heading', { name: /Top risks/ })).toBeVisible();
});

test('run the prepared draft scan end to end and download the exports', async ({ page }) => {
  await page.goto('/');
  await openDemoOrganisation(page);
  await page.getByText('Quarterly quick scan (ready to run)').click();
  // The last wizard step is a short review with no form.
  await expect(page.getByRole('heading', { name: 'Summary', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Start scan' }).click();
  await expect(page).toHaveURL(/\/progress/);
  await expect(page.getByRole('link', { name: 'View report' })).toBeVisible({ timeout: 150_000 });
  await page.getByRole('link', { name: 'View report' }).click();
  await expect(page.getByRole('heading', { name: 'Cloud Security Quick Scan Report' })).toBeVisible();

  for (const label of ['PDF report', 'Findings CSV', 'ISO controls CSV']) {
    const dl = page.waitForEvent('download');
    await page.getByRole('link', { name: label }).click();
    const file = await dl;
    const path = await file.path();
    expect(path, label).toBeTruthy();
    const { statSync } = await import('node:fs');
    expect(statSync(path!).size, label).toBeGreaterThan(500);
  }

  // Triage a finding from the report.
  const finding = page.getByTestId('finding').first();
  await finding.getByRole('button').first().click();
  // Triage applies to this check on this one system, for scans that finish from now on.
  await finding.getByLabel(/Triage status for/).selectOption('accepted');
  await finding.getByPlaceholder('Note (shown in the report)').fill('Accepted in e2e test');
  await finding.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText(/Triage saved for/)).toBeVisible();
  // Finished reports are frozen: the new decision shows as the current decision, not in this report's score.
  await expect(finding.getByText(/Current decision:\s*Risk accepted/)).toBeVisible();
});

test('new organisation through the full wizard with demo systems', async ({ page }) => {
  await page.goto('/');
  await page.goto('/organisations/new');
  await page.getByLabel('Organisation name').fill(`E2E Organisation ${Date.now()}`);
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.getByRole('button', { name: 'New scan' }).click();
  // The wizard starts at Scope: the context and risk profile come from the organisation record.
  await expect(page.getByText('Confirm the organisation context')).toHaveCount(0);
  for (const p of ['Microsoft 365 / Entra ID', 'GitHub']) {
    await page.locator('button', { hasText: p }).first().click();
    // The access methods are radio buttons; click the visible label like a user would.
    await page.getByRole('dialog').getByText('Demo (simulated)', { exact: true }).click();
    await expect(page.getByRole('radio', { name: /Demo \(simulated\)/ })).toBeChecked();
    // GitHub demo systems need no organisation (regression test).
    await page.getByRole('button', { name: 'Add system' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
  }
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Credential retention')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Evaluation criteria')).toBeVisible();
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page.getByRole('heading', { name: 'Summary', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Start scan' }).click();
  await expect(page.getByRole('link', { name: 'View report' })).toBeVisible({ timeout: 150_000 });
});

test('reset demo data restores the original demo organisation', async ({ page }) => {
  await page.goto('/');
  await page.goto('/admin/settings');
  await page.getByRole('button', { name: 'Reset demo data' }).click();
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(page.getByText('Demo data was reset.')).toBeVisible();
  await openDemoOrganisation(page);
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

  await page.getByLabel('Demo PIN').fill('00000000');
  await page.getByRole('button', { name: 'Enter demo' }).click();
  await expect(page.getByText('Invalid PIN')).toBeVisible();
  await page.getByLabel('Demo PIN').fill(DEMO_PIN);
  await page.getByRole('button', { name: 'Enter demo' }).click();
  await expect(page.getByText(/Demo session/)).toBeVisible();
  await page.getByRole('link', { name: 'Organisations', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Organisations' })).toBeVisible();
  await expect(page.getByText(DEMO).first()).toBeVisible();
  await expect(page.getByText(/E2E Organisation/)).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Users', exact: true })).toHaveCount(0);
  await signOut(page);
});
