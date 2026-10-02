# Security QuickScan

**Read-only security quick scans of Microsoft 365 / Entra ID, Azure, AWS and GitHub, evaluated against ISO/IEC 27001:2022 Annex A, with client-ready reports.**

[![Docker image](https://github.com/yopazerbot/security-quickscan/actions/workflows/docker.yml/badge.svg)](https://github.com/yopazerbot/security-quickscan/actions/workflows/docker.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Security QuickScan is a self-hostable web application for security consultants, internal IT teams and auditors who need a fast, repeatable and well-documented view of a company's cloud security posture. It guides you from customer context to a finished report in one flow: capture the context and risk profile, choose the systems in scope, connect with read-only access, review the evaluation criteria, watch the scan run live, and hand over a branded PDF.

Run it on your laptop with one Docker command (no login, nothing leaves your machine), or host it for a team with Microsoft Entra ID single sign-on.

[![Watch the 15-second product video](docs/video/poster.jpg)](docs/video/quickscan-product-video.mp4)

**[Watch the 15-second product video](docs/video/quickscan-product-video.mp4)** (MP4, 1080p). The video is generated from code; see [docs/video/source](docs/video/source).

## Highlights

- **64 automated, read-only checks** across Microsoft 365 / Entra ID (18), Azure (9), AWS (21) and GitHub (16). See the [check catalogue](docs/CHECKS.md).
- **ISO/IEC 27001:2022 Annex A as the backbone.** Every check maps to a primary Annex A control, and results roll up into a per-control verdict: effective, partially effective, not effective or not assessed. CIS and NIS2 references are included as secondary mappings.
- **Risk-based evaluation.** A short customer questionnaire (sector, size, NIS2/DORA/ISO scope, data sensitivity, internet exposure, maturity) produces a risk profile that selects the default criteria and weights the score.
- **Guided, least-privilege access.** Step-by-step instructions per platform, including a ready-made AWS CloudFormation role with external ID and a Microsoft admin-consent flow, so no customer secrets need to be shared. A connection test checks access before scanning.
- **You choose how long credentials are kept** per scan: deleted right after the scan, kept for N days, or kept until you delete them. Secrets are always envelope-encrypted (AES-256-GCM) and never shown again.
- **Live scan progress** with per-system lanes, a live score and an ETA.
- **Reports that are ready to hand over:**
  - an interactive web report: grade and trend, Annex A heatmap, domain radar, top risks, quick wins, filterable findings with evidence and remediation;
  - a branded [PDF report](docs/sample-report.pdf);
  - CSV exports of findings and of the Annex A control assessment.
- **Triage that sticks.** Mark findings as risk accepted or false positive with a note; this carries over to later scans of the same customer and is reflected in the score.
- **Multi-customer and multi-user** (hosted mode): admin, consultant and viewer roles, per-customer access, and an append-only audit log.
- **Demo mode** with a realistic fictional customer, for trying the tool or giving prospects a tour, plus an optional PIN login for demo visitors.

## Screenshots

| | |
| --- | --- |
| ![Dashboard](docs/screenshots/dashboard.png) **Dashboard** | ![Customer](docs/screenshots/customer.png) **Customer history and trend** |
| ![Context](docs/screenshots/customer-context.png) **Customer context and risk profile** | ![Access](docs/screenshots/wizard-access.png) **Guided, read-only access** |
| ![Criteria](docs/screenshots/wizard-criteria.png) **Criteria mapped to ISO 27001 controls** | ![Progress](docs/screenshots/progress.png) **Live scan progress** |
| ![Finding](docs/screenshots/finding.png) **Findings with evidence and remediation** | ![PDF](docs/screenshots/pdf-report.png) **Branded PDF report** |

All screenshots show the built-in fictional demo customer.

## Quick start: run it locally with Docker

Requirements: Docker with Compose.

```bash
git clone https://github.com/yopazerbot/security-quickscan.git
cd security-quickscan
docker compose up -d --build
```

Open **http://localhost:8080**. You are signed in automatically, with no account or configuration needed.

To explore with the fictional demo customer and simulated systems:

```bash
DEMO_MODE=true docker compose up -d --build
```

Useful commands:

| What | Command |
| --- | --- |
| Use another port | `PORT=9000 docker compose up -d` |
| Stop (keep data) | `docker compose down` |
| Stop and delete all data | `docker compose down -v` |
| Update to the latest version | `git pull && docker compose up -d --build` |

Once the image is published to the GitHub Container Registry you can skip `--build`; Compose then pulls `ghcr.io/yopazerbot/security-quickscan:latest`.

### How local mode stays safe without a login

`docker-compose.yml` runs the app with `LOCAL_MODE=true`:

- The port is published on **127.0.0.1 only**, so other machines on your network cannot reach it.
- The app answers only requests addressed to `localhost`, `127.0.0.1` or `[::1]` (this also blocks DNS-rebinding attacks), and it refuses to start in local mode with a non-localhost `APP_URL`.
- CSRF protection and same-origin checks stay active.
- The encryption key for stored customer secrets is generated on first start and kept in the `appdata` Docker volume (`/data/master.key`, readable only by the app). Back up that volume if you keep secrets between scans.
- The container runs as a non-root user with a read-only filesystem and all Linux capabilities dropped. The database is not exposed outside the Compose network.

Do not expose local mode to a network. To share the tool with colleagues or customers, use the hosted setup below.

## How a scan works

1. **Customer context (once per customer).** When you create the customer, answer a short questionnaire. The live risk profile (low, medium, high, critical) shows its drivers and the domain weights it applies. Every new scan uses the current context, so the wizard does not ask for it again; edit the customer to change it.
2. **Scope.** Add the environments to assess: Microsoft 365 tenants, Azure tenants, AWS accounts and GitHub organisations, as many of each as needed.
3. **Access.** Follow the per-platform guidance, store the read-only credentials (or use a secret-less method) and run a connection test. Choose how long secrets are kept.
4. **Criteria.** Review the checks selected for the risk profile, grouped by platform or by ISO control. Exclude anything out of scope with a reason; exclusions appear in the report.
5. **Launch.** Record who authorised the assessment and the validity window (optionally upload the signed letter). Scans cannot run outside that window. Watch the scan run live, then open the report.

Rescan later with one click: scope, criteria and still-valid credentials are copied, and the report shows what was resolved, what is new and what persists.

## What it checks

| Platform | Checks | Examples |
| --- | --- | --- |
| Microsoft 365 / Entra ID | 18 | MFA enforcement and report-only policies, legacy authentication, phishing-resistant admin MFA, Global Administrator count, PIM, user consent and risky app permissions, stale accounts, guest settings, SPF/DMARC, Secure Score |
| Microsoft Azure | 9 | Defender for Cloud plans, public storage, TLS and HTTPS, Key Vault purge protection, NSG management ports, SQL firewall, activity log export, subscription owners |
| Amazon Web Services | 21 | Root MFA and keys, IAM user MFA, key rotation and unused credentials, CloudTrail, GuardDuty, Security Hub, Config, S3 Block Public Access and public buckets, security groups, IMDSv2, RDS exposure, encryption and backups, KMS rotation |
| GitHub | 16 | Organisation 2FA, base permissions, owners, outside collaborators, branch protection and rulesets, secret scanning and push protection, Dependabot and code scanning alerts, Actions policies and token permissions, deploy keys, webhooks |

The full list with severities, Annex A mappings, CIS and NIS2 references is in [docs/CHECKS.md](docs/CHECKS.md).

## The ISO 27001 approach

Each check names one **primary** Annex A control and optionally **secondary** controls. Per control, the verdict is:

| Verdict | Rule |
| --- | --- |
| Effective | all evaluated checks for the control pass |
| Not effective | a primary check of critical or high severity fails, or less than 50% of the weighted evidence passes |
| Partially effective | anything in between |
| Not assessed | only not-applicable or errored checks |

The overall score (0 to 100, graded A to F) weights each check by severity and by the domain weights from the customer's risk profile. Findings marked as false positive count as passed; accepted risks are excluded from the score but listed in the report.

The report states clearly that verdicts reflect **technical evidence only**: organisational aspects of a control (policies, processes, awareness) are outside what an automated scan can see.

## Access methods and required permissions

All access is read-only. The wizard shows these steps in context, with copy buttons.

| Platform | Recommended method | Alternative |
| --- | --- | --- |
| AWS | Cross-account IAM role with a least-privilege inline policy (only the 24 read actions the checks use, no access to data such as S3 objects), assumable only by your scanner identity with a per-engagement external ID. The app generates the CloudFormation template ([infra/aws-scanner-role.yaml](infra/aws-scanner-role.yaml)). `iam:GenerateCredentialReport` is the only non-Get/List/Describe action: it refreshes IAM's own credential report and changes no configuration. | Temporary or dedicated read-only access keys with the same policy |
| Microsoft 365 / Entra ID | Admin consent to your multi-tenant read-only scanner app. Graph application permissions: `Directory.Read.All`, `Policy.Read.All`, `RoleManagement.Read.Directory`, `AuditLog.Read.All`, `Application.Read.All`, `Reports.Read.All`, `SecurityEvents.Read.All` | Customer-created app registration with a short-lived client secret |
| Azure | Same app, plus `Reader` and `Security Reader` on the subscriptions in scope | Customer-created app registration |
| GitHub | Fine-grained personal access token with read-only permissions, created by an organisation owner | Classic token |

Some Microsoft checks need Entra ID P1/P2 licences; without them they are reported as not applicable rather than failed.

## Hosted setup (team use with Microsoft sign-in)

The same Docker image runs as a hosted service. It needs only a Postgres database: no Redis, no object storage. PDFs and CSVs are generated on demand.

### 1. Microsoft Entra app for signing in

In your own tenant: **App registrations > New registration**.

1. Name it, for example `Security QuickScan`, with supported accounts **Accounts in this organizational directory only**.
2. Under **Authentication**, add the **Web** platform with redirect URI `https://<your-domain>/api/auth/callback`. Leave implicit grant unchecked and keep **Allow public client flows** set to **No**.
3. Under **Certificates & secrets**, create a client secret and copy its **Value**.
4. Recommended: in **Enterprise applications**, set **Assignment required** to **Yes** and assign the people who may use the tool. Protect the app with a Conditional Access policy that requires (phishing-resistant) MFA.

Users are invite-only: an administrator adds them under **Users**. The first administrator is created by signing in once with the address in `BOOTSTRAP_ADMIN_EMAIL`; remove that variable afterwards.

### 2. Optional: scanner identities for secret-less customer access

- **Microsoft:** register a second app, **multitenant**, with Web redirect URI `https://<your-domain>/consent/callback` and the Graph application permissions listed above. Create a client secret and set `SCANNER_MS_CLIENT_ID` and `SCANNER_MS_CLIENT_SECRET`. Customers then grant consent via a link from the wizard.
- **AWS:** create an IAM user in your own account with only [infra/scanner-platform-policy.json](infra/scanner-platform-policy.json) attached (it may only assume `SecurityQuickScanReadOnly` roles). Set `SCANNER_AWS_ACCESS_KEY_ID` and `SCANNER_AWS_SECRET_ACCESS_KEY`.

### 3. Deploy

Any Docker host works. Example for [Railway](https://railway.com):

1. Create a project and add **PostgreSQL**.
2. Add **one** service from this repository. It builds the `Dockerfile` using `railway.json`: start command, health check on `/healthz`. If Railway offers to create one service per package of this monorepo, keep a single service with the repository root as root directory.
3. Set the variables (below), generate a domain, and update the redirect URIs in Entra.

Migrations run automatically on start. Enable database backups.

### Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string (on Railway: `${{Postgres.DATABASE_URL}}`) |
| `APP_URL` | yes (hosted) | Public URL without trailing slash, e.g. `https://scan.example.com` |
| `MASTER_KEY` | yes (hosted) | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts stored customer secrets. |
| `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET` | yes (hosted) | Sign-in app from step 1 |
| `BOOTSTRAP_ADMIN_EMAIL` | first start | This account becomes administrator on its first sign-in |
| `ENTRA_REQUIRE_MFA` | no | Reject tokens without an MFA claim |
| `BREAKGLASS_ENABLED`, `BREAKGLASS_USERNAME`, `BREAKGLASS_PASSWORD_HASH`, `BREAKGLASS_TOTP_SECRET` | no | Emergency login when Entra is unavailable: password (Argon2id) plus TOTP, rate limited, audited |
| `SCANNER_MS_CLIENT_ID`, `SCANNER_MS_CLIENT_SECRET` | no | Multi-tenant scanner app (admin consent method) |
| `SCANNER_AWS_ACCESS_KEY_ID`, `SCANNER_AWS_SECRET_ACCESS_KEY` | no | Identity that assumes customer roles |
| `LOCAL_MODE` | no | Single-user local installation without login (see above) |
| `DEMO_MODE` | no | Fictional demo customer and simulated systems |
| `MODE` | no | `all` (default), or run `api` and `worker` as separate services |
| `SESSION_IDLE_MINUTES`, `SESSION_MAX_HOURS` | no | Session timeouts (default 30 minutes idle, 8 hours absolute) |
| `DATABASE_SSL`, `TRUST_PROXY`, `COOKIE_SECURE`, `PORT`, `LOG_LEVEL` | no | Infrastructure settings, see [.env.example](.env.example) |

Generate break-glass values with the bundled CLI:

```bash
npm ci && npm run build -w @qs/server
node apps/server/dist/cli.js hash-password    # BREAKGLASS_PASSWORD_HASH
node apps/server/dist/cli.js gen-totp         # BREAKGLASS_TOTP_SECRET (add the URI to an authenticator app)
node apps/server/dist/cli.js gen-master-key   # MASTER_KEY
```

Rotate the master key by setting `MASTER_KEY_PREVIOUS` to the old key and `MASTER_KEY` to the new one, then running `node apps/server/dist/cli.js rotate-master-key`.

## Security model

- **Authentication (hosted):** Microsoft Entra ID OpenID Connect with authorization code, PKCE, state and nonce, single tenant, tenant ID validated. Tokens stay on the server; the browser only holds a random session cookie (`HttpOnly`, `Secure`, `SameSite=Strict`, `__Host-` prefix) whose hash is stored in Postgres. Sessions expire after 30 minutes idle and 8 hours absolute, and rotate at login.
- **Authorisation:** invite-only users; roles admin, consultant and viewer; customer scoping on every query (other customers return 404, not 403).
- **CSRF:** SameSite=Strict cookies, a per-session CSRF token header, and Origin / `Sec-Fetch-Site` checks on every state-changing request.
- **Customer secrets:** envelope encryption: a fresh AES-256-GCM data key per secret, wrapped by the master key, with authenticated data binding each ciphertext to its scan and system. Secrets are write-only in the API, decrypted only in memory during a connection test or scan, and purged according to the retention you choose.
- **Least privilege:** read-only permissions only. The preferred methods (AWS role with external ID, Microsoft admin consent) avoid exchanging customer secrets at all.
- **Hardening:**
  - strict Content Security Policy (no inline scripts), HSTS, `frame-ancestors 'none'`, no-referrer, Permissions-Policy;
  - rate limiting, request size limits, and input validation with zod on every endpoint;
  - parameterised SQL;
  - HTTP calls to the Microsoft and GitHub APIs are restricted to allow-listed hosts with redirects disabled, and no user-supplied URLs are ever fetched;
  - secrets, cookies and OAuth codes redacted from logs;
  - CSV formula-injection protection, PNG/JPEG-only logo upload, PDF-only authorisation upload.
- **Audit:** an append-only audit log of logins, break-glass and demo access, credential storage, use and purge, scans, exports and admin changes. A database trigger blocks updates and deletes.
- **Supply chain:** lockfile, Dependabot, and CI with typecheck, unit and integration tests, end-to-end tests, `npm audit` and gitleaks, plus CodeQL code scanning.

Found a vulnerability? Please follow [SECURITY.md](SECURITY.md).

## Demo mode

With `DEMO_MODE=true` the app adds simulated systems to the wizard and, on startup, seeds the fictional customer **Noordkust Logistics NV**. It uses only reserved example domains and documentation account IDs. The seed contains:
- two completed scans with an improving trend;
- triaged findings;
- a draft scan ready to run.

Simulated findings are realistic for each check, for example a public invoices bucket, RDP open to the internet, or an MFA policy left in report-only mode. Administrators can reset the demo data under **Settings > Demo data**.

For hosted demos, an administrator can enable a **demo PIN login** in the same place:
- The PIN is 8 to 12 digits and stored as an Argon2 hash.
- Visitors who enter it only see demo customers. They can only add simulated systems, cannot store credentials and cannot open administration pages.
- Attempts are rate limited and locked for 15 minutes after 5 failures.
- Changing the PIN or turning it off ends all demo sessions.

## Architecture

```mermaid
flowchart TB
  SPA["Browser<br/>React single-page app"]
  IDP["Microsoft Entra ID<br/>single sign-on (OIDC)"]
  subgraph Container["Docker container (Node.js)"]
    direction LR
    API["Fastify API<br/>sessions, CSRF, roles, audit log,<br/>PDF and CSV reports"]
    WRK["Scan worker<br/>64 read-only checks,<br/>up to 3 scans in parallel"]
  end
  DB[("PostgreSQL<br/>data, sessions, job queue,<br/>encrypted secrets, uploads")]
  subgraph Customer["Customer environments (read-only access)"]
    direction LR
    GRAPH["Microsoft Graph<br/>M365 and Entra ID"]
    ARM["Azure Resource<br/>Manager"]
    AWS["AWS APIs<br/>STS AssumeRole"]
    GH["GitHub<br/>REST API"]
  end
  SPA -- "HTTPS, session cookie,<br/>live progress (SSE)" --> API
  SPA -. "sign-in" .-> IDP
  API --> DB
  WRK -- "claims queued scans" --> DB
  WRK --> Customer
```

Code layout:

```
apps/web         React 19 single-page app (Vite, Tailwind CSS, TanStack Query, Recharts)
apps/server      Fastify API and scan worker, Drizzle ORM (Postgres), PDFKit reports
packages/shared  Types, ISO 27001 catalogue, check catalogue, risk profiling, scoring
packages/checks  Check implementations: AWS SDK v3, Microsoft Graph, Azure Resource Manager, GitHub REST
e2e              Playwright end-to-end tests
infra            AWS CloudFormation role and scanner policy
```

- One Docker image. By default the API, the built web app and the scan worker run in one process; set `MODE=api` and `MODE=worker` to split them.
- Postgres is the only state: application data, sessions, the job queue (`FOR UPDATE SKIP LOCKED`), encrypted secrets and uploads.
- Each stored secret is encrypted (AES-256-GCM) with its own key, which is wrapped by the master key from `MASTER_KEY` (or a generated key file in local mode). The database alone cannot decrypt anything.
- Scan progress streams to the browser with Server-Sent Events.

## Development

Requirements: Node.js 22 and a Postgres database.

```bash
npm install
cp .env.example .env    # set DATABASE_URL and LOCAL_MODE=true (no login) for the quickest start
npm run dev             # API on :8080, Vite dev server on :5173 (proxies /api)
```

Tests:

```bash
npm run typecheck
npm test                                                      # unit tests
TEST_DATABASE_URL=postgres://localhost/quickscan_test npm test   # plus API, seeding and local-mode tests
DATABASE_URL=postgres://localhost/quickscan_e2e scripts/e2e-local.sh   # Playwright end-to-end suite (empty database)
```

The end-to-end suite starts the app in demo mode and covers:
- the seeded customer and its reports;
- running a scan to completion;
- PDF and CSV downloads, and triage;
- a new customer through the full wizard;
- demo reset, demo PIN login and sign out.

### Adding a check

1. Add its metadata to `packages/shared/src/catalog/<platform>.ts`: severity, domain, minimum risk level, effort, remediation, references and ISO 27001 controls (primary first).
2. Implement it in `packages/checks/src/...`, returning `pass`, `fail`, `warn`, `na` or `error` with the affected resources.
3. Add a demo scenario in `packages/checks/src/demo.ts`.
4. Run `npm test` (it verifies that every check maps to known Annex A controls and has an implementation and a demo scenario) and `npm run docs:checks`.

## Limitations

- This is a point-in-time, automated configuration review. It is not a penetration test, and it does not cover on-premises systems, endpoints or organisational controls.
- Results depend on the permissions and licences available to the scanning identity. Checks that cannot be evaluated are reported as not assessed, never silently passed.
- Repository-level GitHub checks look at the 200 most recently pushed repositories.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). New checks with a clear Annex A mapping and a demo scenario are especially appreciated.

## Responsible use

Only scan environments you are authorised to assess. The tool records the customer's authorisation for each scan and blocks scans outside the authorised window, but the responsibility stays with you. The software is provided without warranty (see the license).

Microsoft, Entra, Azure, AWS and GitHub are trademarks of their respective owners. This project is not affiliated with or endorsed by them. ISO/IEC 27001 control titles are paraphrased for reference.

## License and credit

[MIT](LICENSE), Copyright (c) 2026 Yoshi Parlevliet.

You are free to use, modify, self-host and redistribute Security QuickScan, including commercially, **as long as you credit the author**: keep the copyright and license notice in all copies or substantial portions of the software, and please keep the "Developed by Yoshi Parlevliet" credit visible in the app.

Developed by Yoshi Parlevliet.
