#!/usr/bin/env bash
# Starts the Railcast Worker locally (wrangler dev, local D1/R2) with a test
# user and API token, and waits until it answers. Used by sparkle-e2e.yml.
# Writes RAILCAST_TOKEN / RAILCAST_BASE_URL to $GITHUB_ENV when set.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT=8787
LOG="${RUNNER_TEMP:-/tmp}/wrangler.log"
TOKEN="ci-token-$(openssl rand -hex 12)"
HASH="$(printf %s "$TOKEN" | shasum -a 256 | cut -d' ' -f1)"

cd "$ROOT/worker"
npm ci --no-audit --no-fund

# wrangler.toml serves the dashboard as static assets; the e2e doesn't need it,
# but the directory has to exist.
mkdir -p ../dashboard/out
[ -e ../dashboard/out/index.html ] || echo '<!doctype html><title>e2e</title>' > ../dashboard/out/index.html

npx wrangler d1 migrations apply railcast --local

cat > "$ROOT/e2e-seed.sql" <<SQL
INSERT INTO users (id, email, created_at) VALUES ('e2e-user', 'e2e@example.com', strftime('%s','now'));
INSERT INTO api_tokens (token, id, preview, user_id, created_at, scope)
VALUES ('$HASH', 'e2e-token', 'ci-tok', 'e2e-user', strftime('%s','now'), 'publish');
SQL
npx wrangler d1 execute railcast --local --file "$ROOT/e2e-seed.sql"
rm -f "$ROOT/e2e-seed.sql"

nohup npx wrangler dev --local --ip 127.0.0.1 --port "$PORT" > "$LOG" 2>&1 &
echo "wrangler dev started (pid $!), log: $LOG"

for i in $(seq 1 90); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/me" || true)"
  if [ "$code" != "000" ]; then
    echo "Worker is up after ${i}s (GET /api/me -> $code)"
    if [ -n "${GITHUB_ENV:-}" ]; then
      {
        echo "RAILCAST_TOKEN=$TOKEN"
        echo "RAILCAST_BASE_URL=http://127.0.0.1:$PORT"
      } >> "$GITHUB_ENV"
    fi
    exit 0
  fi
  sleep 1
done

echo "Worker did not start in 90s. Log:" >&2
cat "$LOG" >&2
exit 1
