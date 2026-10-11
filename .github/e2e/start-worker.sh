#!/usr/bin/env bash
# Starts the Railcast Worker locally (wrangler dev, local D1/R2) with a test
# user, an API token and a dashboard session, and waits until it answers.
# Used by sparkle-e2e.yml and stack-e2e.yml.
#
# PUBLIC_FILE_BASE_URL points at http://127.0.0.1:$FILES_PORT, where the tests
# run a mock file host (locally there is no public R2 domain).
#
# Writes RAILCAST_TOKEN, RAILCAST_BASE_URL, E2E_SESSION and E2E_USER_EMAIL to
# $GITHUB_ENV when set.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT=8787
FILES_PORT="${FILES_PORT:-8789}"
USER_EMAIL="e2e@example.com"
LOG="${RUNNER_TEMP:-/tmp}/wrangler.log"
TOKEN="ci-token-$(openssl rand -hex 12)"
HASH="$(printf %s "$TOKEN" | shasum -a 256 | cut -d' ' -f1)"
SESSION_ID="ci-session-$(openssl rand -hex 16)"
SESSION_HASH="$(printf %s "$SESSION_ID" | shasum -a 256 | cut -d' ' -f1)"

cd "$ROOT/worker"
npm ci --no-audit --no-fund

# wrangler.toml serves the dashboard as static assets; the e2e doesn't need it,
# but the directory has to exist.
mkdir -p ../dashboard/out
[ -e ../dashboard/out/index.html ] || echo '<!doctype html><title>e2e</title>' > ../dashboard/out/index.html

npx wrangler d1 migrations apply railcast --local

cat > "$ROOT/e2e-seed.sql" <<SQL
INSERT INTO users (id, email, created_at) VALUES ('e2e-user', '$USER_EMAIL', strftime('%s','now'));
INSERT INTO api_tokens (token, id, preview, user_id, created_at, scope)
VALUES ('$HASH', 'e2e-token', 'ci-tok', 'e2e-user', strftime('%s','now'), 'publish');
INSERT INTO sessions (id, user_id, expires_at, created_at)
VALUES ('$SESSION_HASH', 'e2e-user', strftime('%s','now') + 7200, strftime('%s','now'));
SQL
npx wrangler d1 execute railcast --local --file "$ROOT/e2e-seed.sql"
rm -f "$ROOT/e2e-seed.sql"

nohup npx wrangler dev --local --ip 127.0.0.1 --port "$PORT" \
  --var "PUBLIC_FILE_BASE_URL:http://127.0.0.1:$FILES_PORT" > "$LOG" 2>&1 &
echo "wrangler dev started (pid $!), log: $LOG"

for i in $(seq 1 90); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/me" || true)"
  if [ "$code" != "000" ]; then
    echo "Worker is up after ${i}s (GET /api/me -> $code)"
    if [ -n "${GITHUB_ENV:-}" ]; then
      {
        echo "RAILCAST_TOKEN=$TOKEN"
        echo "RAILCAST_BASE_URL=http://127.0.0.1:$PORT"
        echo "E2E_SESSION=session=$SESSION_ID"
        echo "E2E_USER_EMAIL=$USER_EMAIL"
      } >> "$GITHUB_ENV"
    fi
    exit 0
  fi
  sleep 1
done

echo "Worker did not start in 90s. Log:" >&2
cat "$LOG" >&2
exit 1
