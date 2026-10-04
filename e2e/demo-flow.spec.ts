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

  // A system card filters the findings to that system; selecting it again shows all findings.
  const card = page.locator('[data-testid="system-card"]:not([data-findings="0"])').first();
  const system = (await card.getByTestId('system-card-label').innerText()).trim();
  await card.click();
  await expect(card).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(new RegExp(`shown on ${system.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))).toBeVisible();
  const findings = page.getByTestId('finding');
  await expect(findings.first()).toBeVisible();
  for (const text of await findings.allInnerTexts()) expect(text).toContain(system);
  await card.click();
  await expect(card).toHaveAttribute('aria-pressed', 'false');

  // The demo scans AWS production and AWS acceptance: systems are grouped per environment with a summary each,
  // and the findings can be filtered by environment.
  const groups = page.getByTestId('environment-group');
  await expect(groups).toHaveCount(2);
  await expect(groups.first().getByRole('heading', { name: /production/ })).toBeVisible();
  await expect(groups.nth(1).getByRole('heading', { name: /acceptance/ })).toBeVisible();
  await expect(groups.nth(1).getByTestId('system-card-label')).toHaveText(['AWS acceptance']);
  const envFilter = page.getByLabel('Filter by environment');
  await expect(envFilter.locator('option')).toHaveText(['All environments', 'production', 'acceptance']);
  await envFilter.selectOption({ label: 'acceptance' });
  await expect(page.getByText(/shown in acceptance/)).toBeVisible();
  await expect(findings.first()).toBeVisible();
  for (const text of await findings.allInnerTexts()) expect(text).toContain('AWS acceptance');
  await expect(findings.first().getByTestId('environment-chip').first()).toHaveText(/acceptance/);
  await page.getByRole('button', { name: 'Clear filters' }).first().click();
  await expect(envFilter).toHaveValue('all');
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
  // Checks that do not apply are taken out of the score here, after the scan, instead of in a criteria step.
  await expect(finding.getByRole('option', { name: 'Not applicable / false positive' })).toHaveCount(1);
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
  // An organisation is just a name: no context or risk questionnaire.
  await expect(page.getByRole('textbox')).toHaveCount(1);
  await page.getByLabel('Organisation name').fill(`E2E Organisation ${Date.now()}`);
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.getByRole('button', { name: 'New scan' }).click();
  // Three steps: Scope, Access and Review. Every check for the systems in scope runs.
  await expect(page.getByRole('navigation', { name: 'Scan wizard steps' }).getByRole('listitem')).toHaveCount(3);
  for (const p of ['Microsoft 365 / Entra ID', 'GitHub']) {
    await page.locator('button', { hasText: p }).first().click();
    // The access methods are radio buttons; click the visible label like a user would.
    await page.getByRole('dialog').getByText('Demo (simulated)', { exact: true }).click();
    await expect(page.getByRole('radio', { name: /Demo \(simulated\)/ })).toBeChecked();
    // Environment is optional free text; the default display name follows it.
    if (p === 'GitHub') {
      await page.getByRole('dialog').getByLabel('Environment (optional)').fill('test');
      await expect(page.getByRole('dialog').getByLabel('Display name')).toHaveValue('GitHub test');
    }
    // GitHub demo systems need no organisation (regression test).
    await page.getByRole('button', { name: 'Add system' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
  }
  await expect(page.getByTestId('environment-chip')).toHaveText(['Environment: test']);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Credential retention')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Summary', exact: true })).toBeVisible();
  await expect(page.getByText('Checks to run')).toBeVisible();
  await page.getByRole('button', { name: 'Start scan' }).click();
  await expect(page.getByRole('link', { name: 'View report' })).toBeVisible({ timeout: 150_000 });
});

test('export an organisation and import it into a new one with its history', async ({ page }) => {
  await page.goto('/');
  await openDemoOrganisation(page);
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: `Export ${DEMO}` })).toBeVisible();
  // The passphrase is required and checked before anything is sent.
  await dialog.getByRole('textbox', { name: 'Passphrase', exact: true }).fill('too short');
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(dialog.getByText('Use at least 12 characters.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Generate' }).click();
  const passphrase = (await dialog.locator('code').innerText()).trim();
  expect(passphrase).toMatch(/^[a-z2-9]{5}(-[a-z2-9]{5}){4}$/);
  const dl = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  const download = await dl;
  expect(download.suggestedFilename()).toMatch(/^quickscan-noordkust-logistics-nv-\d{4}-\d{2}-\d{2}\.qsx$/);
  const file = test.info().outputPath('export.qsx');
  await download.saveAs(file);
  await expect(dialog).toBeHidden();

  // Import into a new organisation: demo organisations are never merged into.
  await page.goto('/organisations');
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Export file').setInputFiles(file);
  await dialog.getByRole('textbox', { name: 'Passphrase', exact: true }).fill(`${passphrase}x`);
  await dialog.getByRole('button', { name: 'Preview' }).click();
  await expect(dialog.getByText('The passphrase is wrong or the file was modified')).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Passphrase', exact: true }).fill(passphrase);
  await dialog.getByRole('button', { name: 'Preview' }).click();
  await expect(dialog.getByText('New organisation', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Import finished' })).toBeVisible();
  await dialog.getByRole('link', { name: DEMO }).click();
  await expect(page.getByRole('heading', { name: DEMO })).toBeVisible();
  const copyUrl = page.url();
  // The history came along: the trend, the scans with their import mark, and reports that compare.
  await expect(page.getByRole('heading', { name: 'Score trend' })).toBeVisible();
  expect(await page.getByTitle(/^Imported on/).count()).toBeGreaterThanOrEqual(2);
  await page.getByText('Follow-up quick scan').click();
  await expect(page.getByRole('heading', { name: 'Cloud Security Quick Scan Report' })).toBeVisible();
  await expect(page.getByTitle(/^Imported on/)).toBeVisible();
  await expect(page.getByText(/Since the previous scan/)).toBeVisible();

  // Importing the same file again finds everything already present.
  await page.goto('/organisations');
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Export file').setInputFiles(file);
  await dialog.getByRole('textbox', { name: 'Passphrase', exact: true }).fill(passphrase);
  await dialog.getByRole('button', { name: 'Preview' }).click();
  await expect(dialog.getByText(`Merge into ${DEMO}`)).toBeVisible();
  await expect(dialog.getByText(/already here/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Import', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Close' }).click();

  // Remove the copy again, so the demo organisation is the only one with this name.
  await page.goto(copyUrl);
  await page.getByRole('button', { name: 'Delete organisation and all data' }).click();
  await page.getByRole('button', { name: 'Delete permanently' }).click();
  await expect(page.getByRole('heading', { name: 'Organisations' })).toBeVisible();
});

test('reset demo data restores the original demo organisation', async ({ page }) => {
  await page.goto('/');
  await page.goto('/admin/settings?tab=demo');
  await page.getByRole('button', { name: 'Reset demo data' }).click();
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(page.getByText('Demo data was reset.')).toBeVisible();
  await openDemoOrganisation(page);
  await expect(page.getByText('Quarterly quick scan (ready to run)')).toBeVisible();
});

test('admin tables sort and page, and the audit log shows Brussels time', async ({ page }) => {
  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { name: 'Users', exact: true })).toBeVisible();
  const rowsPerPage = page.getByLabel('Rows per page');
  await rowsPerPage.selectOption('50');
  await expect(rowsPerPage).toHaveValue('50');
  const roleHeader = page.getByRole('columnheader', { name: 'Role' });
  await roleHeader.getByRole('button').click();
  await expect(roleHeader).toHaveAttribute('aria-sort', 'ascending');
  await roleHeader.getByRole('button').click();
  await expect(roleHeader).toHaveAttribute('aria-sort', 'descending');
  await roleHeader.getByRole('button').click();
  await expect(roleHeader).toHaveAttribute('aria-sort', 'none');
  await rowsPerPage.selectOption('10');

  await page.goto('/admin/audit');
  await expect(page.getByRole('columnheader', { name: /Time \(Brussels\)/ })).toHaveAttribute('aria-sort', 'descending');
  await expect(page.getByTestId('audit-time').first()).toHaveText(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/);
  await page.getByLabel('Rows per page').selectOption('10');
  await expect(page.getByTestId('pager-status')).toHaveText(/^Entries 1 to \d+/);
  expect(await page.getByTestId('audit-time').count()).toBeLessThanOrEqual(10);
  const next = page.getByRole('button', { name: 'Next page of audit entries' });
  if (await next.isEnabled()) {
    await next.click();
    await expect(page.getByTestId('pager-status')).toHaveText(/^Entries 11 to /);
    await page.getByRole('button', { name: 'Previous page of audit entries' }).click();
    await expect(page.getByTestId('pager-status')).toHaveText(/^Entries 1 to /);
  }
});

// Runs last: signing out ends the shared admin session.
test('demo PIN login: admin enables it, visitor only sees demo data, sign out works', async ({ page }) => {
  await page.goto('/');
  await page.goto('/admin/settings?tab=demo');
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
