#!/usr/bin/env bash
# End-to-end test of the whole stack on Linux, with made-up data: the real
# Worker (wrangler dev, local D1/R2), the real CLI, a mock file host, and
# OpenSSL as an independent check of the signatures. No Mac, no real app, no
# real data needed.
#
# It covers: importing an existing Sparkle-style key, publishing, signature
# verification by a third party, yank/restore, export (with hash checks and
# tamper detection), moving the feed with a redirect, and deleting the account.
#
# Needs: RAILCAST (built CLI), RAILCAST_TOKEN, RAILCAST_BASE_URL, E2E_SESSION,
# E2E_USER_EMAIL (see start-worker.sh); openssl 3, zip, python3, curl.
set -euo pipefail

: "${RAILCAST:?}" "${RAILCAST_TOKEN:?}" "${RAILCAST_BASE_URL:?}" "${E2E_SESSION:?}" "${E2E_USER_EMAIL:?}"
FILES_PORT="${FILES_PORT:-8789}"
STATIC_PORT="${STATIC_PORT:-8788}"
WORK="$(mktemp -d)"
PIDS=()

step() { printf '\n==> %s\n' "$*"; }
ok()   { printf '  ok: %s\n' "$*"; }
fail() { printf '\nFAIL: %s\n' "$*" >&2; exit 1; }
cleanup() { for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

# `cmd | grep -q` is unsafe under pipefail: grep -q exits at the first match, the
# writer gets SIGPIPE and the whole pipeline "fails" (or, in `|| fail`/`&& fail`
# checks, silently passes) depending on timing. So capture output first, then
# grep a here-string.
feed() { curl -fsS "$FEED"; }
has()  { grep -qi -- "$1" <<<"$2"; }   # has <pattern> <text>

http_code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
expect_code() { # description expected-code curl-args...
  local desc="$1" want="$2"; shift 2
  local got; got="$(http_code "$@")"
  [ "$got" = "$want" ] || fail "$desc: expected HTTP $want, got $got"
  ok "$desc (HTTP $got)"
}
# Runs a command that must fail; prints its output and returns it in $OUT.
must_fail() { # description command...
  local desc="$1"; shift
  if OUT="$("$@" 2>&1)"; then echo "$OUT"; fail "$desc: expected a non-zero exit"; fi
  ok "$desc (refused)"
}

mkdir -p "$WORK"/{proj,build,files,static}

# --- 0. a made-up "existing Sparkle key" -------------------------------------
# Sparkle's generate_keys exports a 32-byte seed (base64); build the same thing
# with OpenSSL, plus the expected public key and a PEM for independent checks.
step "Create an Ed25519 key in Sparkle's export format"
openssl genpkey -algorithm ed25519 -out "$WORK/key.pem" 2>/dev/null
openssl pkey -in "$WORK/key.pem" -outform DER 2>/dev/null | tail -c 32 | base64 | tr -d '\n' > "$WORK/sparkle_private_key"
openssl pkey -in "$WORK/key.pem" -pubout -outform DER 2>/dev/null | tail -c 32 | base64 | tr -d '\n' > "$WORK/expected_pub"
openssl pkey -in "$WORK/key.pem" -pubout -out "$WORK/pub.pem" 2>/dev/null
cp "$WORK/sparkle_private_key" "$WORK/sparkle_private_key.orig"
EXPECTED_PUB="$(cat "$WORK/expected_pub")"
echo "expected SUPublicEDKey: $EXPECTED_PUB"

# --- 1. init --import-key ----------------------------------------------------
step "railcast init --import-key"
cd "$WORK/proj"
"$RAILCAST" init --app myapp --import-key "$WORK/sparkle_private_key" --token "$RAILCAST_TOKEN" --base-url "$RAILCAST_BASE_URL"
APP_ID="$(python3 -c 'import json;print(json.load(open(".railcast.json"))["app"])')"
FEED="$RAILCAST_BASE_URL/$APP_ID/appcast.xml"
REGISTERED="$(curl -fsS -H "Authorization: Bearer $RAILCAST_TOKEN" "$RAILCAST_BASE_URL/api/apps" \
  | python3 -c "import json,sys;print([a for a in json.load(sys.stdin)['apps'] if a['id']=='$APP_ID'][0]['signing_public_key'])")"
[ "$REGISTERED" = "$EXPECTED_PUB" ] || fail "server registered $REGISTERED, expected the imported key's $EXPECTED_PUB"
ok "the server registered the public key of the imported key"
cmp "$WORK/sparkle_private_key" "$WORK/sparkle_private_key.orig" || fail "the original key file was modified"
[ -f myapp.key ] || fail "no myapp.key was written"
ok "original key file untouched, copy written to myapp.key"

# --- 2. publish, and verify the signature with OpenSSL -----------------------
publish() { # version build [extra flags...]
  local v="$1" b="$2"; shift 2
  echo "payload for $v" > "$WORK/build/MyApp-$v.txt"
  head -c 4096 /dev/urandom >> "$WORK/build/MyApp-$v.txt"
  (cd "$WORK/build" && zip -q "MyApp-$v.zip" "MyApp-$v.txt")
  "$RAILCAST" publish -f "$WORK/build/MyApp-$v.zip" -v "$v" -b "$b" --notes "## What's new in $v" "$@" > "$WORK/publish-$v.log" 2>&1 \
    || { cat "$WORK/publish-$v.log"; fail "publish $v failed"; }
}
step "railcast publish 1.0.0 and 1.1.0"
publish 1.0.0 1
publish 1.1.0 2 --min-system-version 12.0
curl -fsS "$FEED" > "$WORK/feed.xml"
grep -q '<sparkle:shortVersionString>1.1.0<' "$WORK/feed.xml" || fail "feed doesn't offer 1.1.0"
grep -q '<sparkle:minimumSystemVersion>12.0<' "$WORK/feed.xml" || fail "minimum system version missing from the feed"
grep -q 'sparkle:format="markdown"' "$WORK/feed.xml" || fail "release notes aren't marked as markdown"
ok "feed offers 1.1.0 with minimum system version and markdown notes"
HEADERS="$(curl -sD - -o /dev/null "$FEED" | tr -d '\r')"
grep -qi '^cache-control: no-cache$' <<<"$HEADERS" \
  || fail "the feed must be sent with Cache-Control: no-cache (a browser must not hold it)"
ok "the feed tells clients to revalidate (Cache-Control: no-cache)"

for v in 1.0.0 1.1.0; do
  sig="$(python3 - "$WORK/feed.xml" "$v" <<'PY'
import re, sys
xml, ver = open(sys.argv[1]).read(), sys.argv[2]
item = [i for i in xml.split("<item>")[1:] if f"<sparkle:shortVersionString>{ver}<" in i][0]
print(re.search(r'sparkle:edSignature="([^"]+)"', item).group(1))
PY
)"
  echo "$sig" | base64 -d > "$WORK/sig-$v.bin"
  openssl pkeyutl -verify -pubin -inkey "$WORK/pub.pem" -rawin -in "$WORK/build/MyApp-$v.zip" -sigfile "$WORK/sig-$v.bin" >/dev/null \
    || fail "OpenSSL does not verify the signature of $v with the imported key's public half"
done
ok "OpenSSL verifies both signatures with the imported key (independent of our own code)"

# --- 3. yank / restore --------------------------------------------------------
step "railcast yank / --undo"
"$RAILCAST" yank 1.1.0 > "$WORK/yank.log" 2>&1 || { cat "$WORK/yank.log"; fail "yank failed"; }
has '<sparkle:shortVersionString>1.1.0<' "$(feed)" && fail "1.1.0 is still in the feed after yank"
has '<sparkle:shortVersionString>1.0.0<' "$(feed)" || fail "1.0.0 should be served after yanking 1.1.0"
ok "yanked release is gone from the feed, the previous one is served"
must_fail "yanking the only live release" "$RAILCAST" yank 1.0.0
"$RAILCAST" yank 1.1.0 --undo >/dev/null 2>&1 || fail "yank --undo failed"
has '<sparkle:shortVersionString>1.1.0<' "$(feed)" || fail "1.1.0 should be back after --undo"
ok "restored"

# --- 4. export with a mock file host -----------------------------------------
step "railcast export (mock file host, hash checks)"
mkdir -p "$WORK/files/$APP_ID"
cp "$WORK/build/MyApp-1.0.0.zip" "$WORK/build/MyApp-1.1.0.zip" "$WORK/files/$APP_ID/"
python3 -m http.server "$FILES_PORT" --bind 127.0.0.1 --directory "$WORK/files" > "$WORK/files.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 20); do curl -fsS "http://127.0.0.1:$FILES_PORT/$APP_ID/MyApp-1.0.0.zip" -o /dev/null 2>/dev/null && break; sleep 0.5; done

"$RAILCAST" yank 1.1.0 >/dev/null 2>&1   # a yanked release must be exported, but not appear in the feed
FILES_URL="http://127.0.0.1:$FILES_PORT"
"$RAILCAST" export --app "$APP_ID" --out "$WORK/out" --files-url "$FILES_URL" > "$WORK/export.log" 2>&1 \
  || { cat "$WORK/export.log"; fail "export failed"; }
cat "$WORK/export.log"
for v in 1.0.0 1.1.0; do
  cmp "$WORK/out/files/$APP_ID/MyApp-$v.zip" "$WORK/build/MyApp-$v.zip" || fail "exported $v differs from what was published"
done
ok "both release files exported, byte for byte"
python3 - "$WORK/out/releases.json" <<'PY' || fail "releases.json is wrong"
import json, sys
d = json.load(open(sys.argv[1]))
assert len(d["releases"]) == 2, "expected 2 releases"
assert all(r["signature"] and r["sha256"] and r["file_key"] for r in d["releases"])
assert {r["version"]: r["yanked"] for r in d["releases"]} == {"1.0.0": 0, "1.1.0": 1}
assert d["app"]["signing_public_key"]
PY
ok "releases.json has both releases with signatures, hashes and the yanked flag"
grep -q "$FILES_URL" "$WORK/out/appcast.xml" || fail "exported appcast doesn't point at the files URL"
grep -q '<sparkle:shortVersionString>1.0.0<' "$WORK/out/appcast.xml" || fail "exported appcast lacks 1.0.0"
grep -q '<sparkle:shortVersionString>1.1.0<' "$WORK/out/appcast.xml" && fail "exported appcast contains the yanked 1.1.0"
ok "exported appcast points at the new host and leaves out the yanked release"

SECOND="$("$RAILCAST" export --app "$APP_ID" --out "$WORK/out" --files-url "$FILES_URL" 2>&1)" || { echo "$SECOND"; fail "the second export failed"; }
has "already there" "$SECOND" || fail "a second export should skip files that are already there"
ok "re-running export skips what it already has"

expect_code "export through the dashboard session" 200 -H "Cookie: $E2E_SESSION" "$RAILCAST_BASE_URL/$APP_ID/export"

echo "tampered content" > "$WORK/files/$APP_ID/MyApp-1.0.0.zip"
rm -rf "$WORK/out2"
must_fail "export of a file that doesn't match its hash" "$RAILCAST" export --app "$APP_ID" --out "$WORK/out2"
has "mismatch" "$OUT" || fail "the failure should mention a hash/size mismatch, got: $OUT"
[ -z "$(find "$WORK/out2" -name '.download-*' 2>/dev/null)" ] || fail "a failed download left a partial file behind"
ok "tampered file detected (mismatch), nothing partial left behind"
cp "$WORK/build/MyApp-1.0.0.zip" "$WORK/files/$APP_ID/MyApp-1.0.0.zip"

# --- 5. move the feed ----------------------------------------------------------
step "railcast redirect (to the exported feed)"
cp "$WORK/out/appcast.xml" "$WORK/static/appcast.xml"
python3 -m http.server "$STATIC_PORT" --bind 127.0.0.1 --directory "$WORK/static" > "$WORK/static.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 20); do curl -fsS "http://127.0.0.1:$STATIC_PORT/appcast.xml" -o /dev/null 2>/dev/null && break; sleep 0.5; done

must_fail "redirect to something that isn't a feed" "$RAILCAST" redirect --to "http://127.0.0.1:$FILES_PORT/"
has "appcast" "$OUT" || fail "the refusal should say the target isn't an appcast, got: $OUT"
[ "$(http_code "$FEED")" = "200" ] || fail "a refused redirect must leave the feed alone"
ok "a bad target is refused and the feed is unchanged"

"$RAILCAST" redirect --to "http://127.0.0.1:$STATIC_PORT/appcast.xml" >/dev/null 2>&1 || fail "redirect --to failed"
LOC="$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$FEED")"
[ "$LOC" = "302 http://127.0.0.1:$STATIC_PORT/appcast.xml" ] || fail "feed should answer 302 to the static host, got: $LOC"
has "$FILES_URL" "$(curl -sL "$FEED")" || fail "following the redirect should land on the exported feed"
ok "old feed URL answers 302 and lands on the exported feed"
has "$STATIC_PORT" "$("$RAILCAST" redirect 2>&1)" || fail "railcast redirect (no flags) should show the current target"

"$RAILCAST" redirect --clear >/dev/null 2>&1 || fail "redirect --clear failed"
expect_code "feed served by Railcast again after --clear" 200 "$FEED"

# --- 6. delete the account (dashboard session) ---------------------------------
step "account deletion"
del() { # email
  curl -s -o /dev/null -w '%{http_code}' -X DELETE -H "Cookie: $E2E_SESSION" -H 'Content-Type: application/json' \
    -d "{\"confirm_email\":\"$1\"}" "$RAILCAST_BASE_URL/api/me"
}
expect_code "deleting with a bearer token is refused" 401 -X DELETE -H "Authorization: Bearer $RAILCAST_TOKEN" \
  -H 'Content-Type: application/json' -d "{\"confirm_email\":\"$E2E_USER_EMAIL\"}" "$RAILCAST_BASE_URL/api/me"
[ "$(del "someone-else@example.com")" = "400" ] || fail "a wrong confirmation email must be refused"
ok "wrong confirmation email refused (HTTP 400)"
[ "$(del "$E2E_USER_EMAIL")" = "204" ] || fail "deleting with the right email should succeed"
ok "account deleted (HTTP 204)"
expect_code "the feed is gone" 404 "$FEED"
expect_code "the API token no longer works" 401 -H "Authorization: Bearer $RAILCAST_TOKEN" "$RAILCAST_BASE_URL/api/apps"
expect_code "the session no longer works" 401 -H "Cookie: $E2E_SESSION" "$RAILCAST_BASE_URL/api/me"

step "ALL CHECKS PASSED"
