#!/usr/bin/env bash
# Runs the end-to-end suite against a throwaway server in demo mode.
# Usage: DATABASE_URL=postgres://user:pass@localhost:5432/quickscan_e2e scripts/e2e-local.sh
# The database should be empty (it is migrated and seeded with demo data).
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?Set DATABASE_URL to an empty Postgres database}"
PORT="${PORT:-8080}"

npm run build >/dev/null
export E2E_BG_USER=e2e-admin
export E2E_BG_PASSWORD="$(node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))")"
HASH="$(echo "$E2E_BG_PASSWORD" | node apps/server/dist/cli.js hash-password 2>/dev/null)"
export E2E_BG_TOTP_SECRET="$(node apps/server/dist/cli.js gen-totp e2e | awk '/Secret/{print $2}')"

APP_URL="http://localhost:$PORT" PORT="$PORT" MASTER_KEY="$(node apps/server/dist/cli.js gen-master-key)" \
  COOKIE_SECURE=false TRUST_PROXY=false DEMO_MODE=true LOG_LEVEL=warn \
  BREAKGLASS_ENABLED=true BREAKGLASS_USERNAME="$E2E_BG_USER" BREAKGLASS_PASSWORD_HASH="$HASH" BREAKGLASS_TOTP_SECRET="$E2E_BG_TOTP_SECRET" \
  node apps/server/dist/main.js &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do curl -sf "http://localhost:$PORT/healthz" >/dev/null && break; sleep 1; done

E2E_BASE_URL="http://localhost:$PORT" npx playwright test "$@"
