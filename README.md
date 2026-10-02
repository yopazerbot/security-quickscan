# Security QuickScan

A web application for running read-only security quick scans of customer cloud environments (Microsoft 365 / Entra ID, Azure, AWS and GitHub), with results evaluated against **ISO/IEC 27001:2022 Annex A**.

Built for a freelance security consultant: capture the customer context, derive a risk profile, scope the systems, collect access securely with step-by-step guidance, review the evaluation criteria, watch the scan run live and hand over a branded report.

## Features

- **Guided scan wizard**
  1. Customer context questionnaire that produces a risk profile (low / medium / high / critical) with drivers and domain weights.
  2. Scope: add any number of M365 tenants, Azure tenants, AWS accounts and GitHub organisations.
  3. Access: per-platform guidance (CloudFormation template, admin consent link, permission lists, CLI snippets), secure credential capture, connection test, and a **per-scan credential retention choice** (delete after scan, keep N days, keep until deleted).
  4. Criteria: 64 checks, defaults based on the risk profile, include/exclude with a recorded reason, grouped by platform or by ISO control.
  5. Launch: record the customer authorisation (who, when, validity window, optional signed PDF). Scans cannot run outside the window.
- **Live progress**: per-system lanes with animated check tiles, live score and grade, ETA, cancel.
- **Reports**
  - In-app report: grade, score trend versus previous scan, ISO 27001 Annex A control heatmap (effective / partial / not effective / not assessed), domain radar, severity chart, top risks, quick wins, filterable findings with affected resources, evidence and remediation.
  - Branded PDF (cover, executive summary, Annex A table, priorities, detailed findings, scope, method and limitations, disclaimer, TLP marking).
  - CSV exports for findings and for the Annex A control assessment.
- **Triage**: mark findings as risk accepted or false positive with a note; carried over to future scans of the same customer and reflected in the score.
- **Multi-customer** with per-customer access for associates, rescan (clones scope, criteria and still-valid credentials), customer data export and full deletion.
- **User management**: invite-only, roles admin / consultant / viewer, sign out everywhere, append-only audit log.

## ISO 27001 as the central framework

Every check maps to one primary Annex A control and optional secondary controls (`packages/shared/src/catalog/*`). Control verdicts:

| Verdict | Rule |
| --- | --- |
| Effective | all evaluated checks for the control pass |
| Not effective | a primary critical/high check fails, or less than 50% of the weighted evidence passes |
| Partially effective | anything in between |
| Not assessed | only n/a or errored checks |

CIS benchmark and NIS2 article references are kept as secondary references. The report states clearly that the verdict covers technical evidence only.

## Architecture

```
apps/web         React 19 SPA (Vite, Tailwind, TanStack Query, Recharts)
apps/server      Fastify API + scan worker, Drizzle ORM, PDFKit
packages/shared  types, ISO catalog, check catalog, risk profiling, scoring (used by UI and server)
packages/checks  check implementations (AWS SDK v3, Microsoft Graph, Azure Resource Manager, GitHub REST)
```

- One Docker image. `MODE=all` runs API and worker in one process (simplest on Railway). For isolation you can run two services from the same image with `MODE=api` and `MODE=worker`.
- Postgres is the only state: data, sessions, job queue (`FOR UPDATE SKIP LOCKED`), encrypted secrets and uploads. No S3 or volume needed; PDFs and CSVs are generated on demand.
- Progress is streamed to the browser with Server-Sent Events.

## Security model

- **Authentication**: Microsoft Entra ID OIDC (authorization code + PKCE, state and nonce, single tenant, `tid` validated) in a backend-for-frontend design: the browser never holds tokens. Sessions are random tokens stored hashed in Postgres, in a `__Host-` cookie that is HttpOnly, Secure and SameSite=Strict. 30 minute idle and 8 hour absolute timeout, rotation on login.
- **Break glass**: only when `BREAKGLASS_ENABLED=true`. Username + Argon2id password hash + TOTP (single use), rate limited and locked after 5 failures, audited, and shown as a red banner during the session.
- **Authorisation**: invite-only users, role checks on every route, customer scoping on every query (404 for customers you cannot access), viewers are read-only.
- **CSRF**: SameSite=Strict, per-session CSRF token header, Origin and Sec-Fetch-Site checks on every mutating request.
- **Customer secrets**: envelope encryption (AES-256-GCM data key per secret, wrapped by `MASTER_KEY`), additional authenticated data binds each ciphertext to its scan and system. Secrets are write-only in the API, decrypted in memory only for a connection test or scan, and deleted according to the chosen retention (purge job runs every minute). Key rotation: `node apps/server/dist/cli.js rotate-master-key`.
- **Least privilege access**: preferred methods need no shared customer secret at all (AWS cross-account role with external ID, Microsoft admin consent to a read-only multi-tenant app). All permissions are read-only.
- **Hardening**: strict CSP (no inline scripts), HSTS, frame-ancestors none, no-referrer, Permissions-Policy, rate limiting, request size limits, zod validation on all inputs, parameterised SQL, outbound requests only to allow-listed API hosts with redirects disabled, log redaction of secrets, cookies and OAuth codes, CSV formula-injection protection, PNG/JPEG-only logo upload, PDF-only authorisation upload.
- **Audit**: append-only `audit_log` (database trigger blocks UPDATE, DELETE and TRUNCATE).
- **Supply chain**: lockfile, Dependabot, CI with typecheck, tests, `npm audit`, CodeQL and gitleaks. The runtime image runs as a non-root user with root-owned, read-only application files.

## Setup

### 1. Entra app for signing in (your own tenant)

1. Entra admin center, App registrations, New registration: "Security QuickScan", single tenant.
2. Redirect URI (Web): `https://<your-domain>/api/auth/callback`.
3. Certificates and secrets: create a client secret.
4. Set `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET` and `BOOTSTRAP_ADMIN_EMAIL` (your account). Your first sign-in creates the admin user; afterwards remove `BOOTSTRAP_ADMIN_EMAIL`.
5. Recommended: in Enterprise applications set "Assignment required" and assign only yourself and associates, and protect the app with a Conditional Access policy requiring phishing-resistant MFA.

### 2. Scanner app for Microsoft customers (optional, enables admin consent)

1. New registration: "Security QuickScan Reader", **multi-tenant** (accounts in any organisational directory).
2. Redirect URI (Web): `https://<your-domain>/consent/callback`.
3. API permissions, Microsoft Graph, **Application** permissions: `Directory.Read.All`, `Policy.Read.All`, `RoleManagement.Read.Directory`, `AuditLog.Read.All`, `Application.Read.All`, `Reports.Read.All`, `SecurityEvents.Read.All`.
4. Create a client secret and set `SCANNER_MS_CLIENT_ID` and `SCANNER_MS_CLIENT_SECRET`.

Without it, the app falls back to customer-created app registrations.

### 3. AWS scanner identity (optional, enables cross-account roles)

Create an IAM user in your own AWS account with only `infra/scanner-platform-policy.json` attached (it may only assume `SecurityQuickScanReadOnly` roles), create an access key and set `SCANNER_AWS_ACCESS_KEY_ID` and `SCANNER_AWS_SECRET_ACCESS_KEY`. Customers deploy `infra/aws-scanner-role.yaml` (the app shows a pre-filled version with the per-engagement external ID).

### 4. Deploy on Railway

1. Create a project, add the **PostgreSQL** plugin.
2. Add a service from this repository. Railway builds the `Dockerfile` (see `railway.json`, health check `/healthz`).
3. Variables: copy from `.env.example`. Use `DATABASE_URL=${{Postgres.DATABASE_URL}}`, set `APP_URL` to the public domain, generate `MASTER_KEY` with `openssl rand -base64 32`.
4. Add a custom domain and update the redirect URIs in the Entra apps.
5. Migrations run automatically on start.

Optional: a second service from the same repo with `MODE=worker` and the first one with `MODE=api`.

Backups: enable Railway Postgres backups. Losing `MASTER_KEY` only makes currently stored customer secrets unreadable; reports and results stay intact.

## Local development

```bash
npm install
cp .env.example .env    # set DATABASE_URL, MASTER_KEY, APP_URL=http://localhost:5173, COOKIE_SECURE=false, DEMO_MODE=true
npm run dev             # API on :8080, Vite on :5173 (proxies /api)
```

For a quick local login without Entra, enable break glass:

```bash
npm run build -w @qs/server
node apps/server/dist/cli.js hash-password   # BREAKGLASS_PASSWORD_HASH
node apps/server/dist/cli.js gen-totp        # BREAKGLASS_TOTP_SECRET, add the URI to an authenticator app
```

`DEMO_MODE=true` adds a "Demo (simulated)" access method that produces realistic results without connecting anywhere.

Tests:

```bash
npm test                                                     # unit tests
TEST_DATABASE_URL=postgres://localhost/quickscan_test npm test   # plus API authorisation tests
```

Or run the full stack with Docker: `docker compose up --build`.

## Adding a check

1. Add metadata to `packages/shared/src/catalog/<provider>.ts` (severity, domain, minimum risk level, effort, remediation, references, ISO 27001 controls with the primary first).
2. Implement it in `packages/checks/src/...` returning `pass`, `fail`, `warn`, `na` or `error` with affected resources.
3. `npm test` verifies that every catalog entry maps to known Annex A controls and has an implementation.

## Limitations

- Point-in-time, automated configuration review; no penetration testing and no organisational controls.
- Some Microsoft checks need Entra ID P1/P2 licences and are reported as not applicable otherwise.
- GitHub checks assume a token of an organisation owner for full visibility; repository-level checks are capped at 200 most recently pushed repositories.
