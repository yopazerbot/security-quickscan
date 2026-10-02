# Contributing

Thanks for your interest in improving Security QuickScan.

## Getting started

```bash
npm install
cp .env.example .env    # set DATABASE_URL and LOCAL_MODE=true
npm run dev
```

Before opening a pull request, run:

```bash
npm run typecheck
TEST_DATABASE_URL=postgres://localhost/quickscan_test npm test
DATABASE_URL=postgres://localhost/quickscan_e2e scripts/e2e-local.sh   # for UI changes
```

## Adding or changing checks

Checks are the heart of the project. A good check:

- is **read-only** and uses the least privilege possible (document any extra permission in the catalogue `requires` field and the README);
- maps to one **primary ISO/IEC 27001:2022 Annex A control** (plus secondary controls where relevant) and, where applicable, CIS and NIS2 references;
- returns `na` (not `pass`) when it cannot evaluate, for example because of a missing licence or permission;
- lists affected resources with enough detail to act on, and never includes secrets in its evidence;
- has a realistic scenario in `packages/checks/src/demo.ts` and tests for its logic where practical.

Update `docs/CHECKS.md` with `npm run docs:checks`.

## Pull requests

- Keep changes focused, and describe the motivation and how you tested.
- Follow the existing code style (TypeScript, zod validation at the API boundary, no secrets in logs).
- Security-relevant changes (authentication, authorisation, crypto, credential handling) get extra review; explain the threat model in the PR.

By contributing you agree that your contributions are licensed under the [MIT license](LICENSE) of this project.
