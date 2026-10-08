#!/usr/bin/env bash
# End-to-end check with a REAL Sparkle client: publish releases through the
# Railcast CLI to a local Worker, let Sparkle's command-line updater look at
# the feed, then move the feed with `railcast redirect` and check that the
# client follows the 302.
#
# Needs: SPARKLE_DIR (extracted Sparkle release), RAILCAST (built CLI),
# RAILCAST_TOKEN and RAILCAST_BASE_URL (see start-worker.sh). macOS only
# (PlistBuddy, ditto, Sparkle).
set -euo pipefail

: "${SPARKLE_DIR:?}" "${RAILCAST:?}" "${RAILCAST_TOKEN:?}" "${RAILCAST_BASE_URL:?}"
STATIC_PORT=8788
WORK="$(mktemp -d)"
PROBE_TIMEOUT=90

log()  { printf '\n==> %s\n' "$*"; }
fail() { printf '\nFAIL: %s\n' "$*" >&2; exit 1; }
trap '[ -n "${STATIC_PID:-}" ] && kill "$STATIC_PID" 2>/dev/null || true' EXIT

# --- 1. find Sparkle's command-line updater -------------------------------
log "Sparkle release contents"
find "$SPARKLE_DIR" -maxdepth 3 -not -path '*/Sparkle.framework/*' | sort | head -60

# SPARKLE_CLI can be set by the workflow (e.g. when it had to be built from source).
SPARKLE_CLI="${SPARKLE_CLI:-$(find "$SPARKLE_DIR" -type f -perm -u+x \( -name sparkle-cli -o -path '*sparkle.app/Contents/MacOS/*' \) | head -n 1)}"
[ -n "$SPARKLE_CLI" ] || fail "no sparkle-cli / sparkle.app in the Sparkle release (see the listing above) — it has to be built from source instead"
log "Using Sparkle's updater: $SPARKLE_CLI"

# --- 2. a throwaway app, built twice, and an "installed" copy --------------
make_app() { # dir version build [feed-url pubkey]
  local dir="$1" version="$2" build="$3" feed="${4:-}" pub="${5:-}"
  rm -rf "$dir/MyApp.app"
  mkdir -p "$dir/MyApp.app/Contents/MacOS"
  printf '#!/bin/sh\nexit 0\n' > "$dir/MyApp.app/Contents/MacOS/MyApp"
  chmod +x "$dir/MyApp.app/Contents/MacOS/MyApp"
  cat > "$dir/MyApp.app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.example.myapp</string>
  <key>CFBundleName</key><string>MyApp</string>
  <key>CFBundleExecutable</key><string>MyApp</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$build</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  $( [ -n "$feed" ] && echo "<key>SUFeedURL</key><string>$feed</string>" )
  $( [ -n "$pub" ] && echo "<key>SUPublicEDKey</key><string>$pub</string>" )
</dict></plist>
PLIST
}

build_zip() { # version build
  make_app "$WORK/build" "$1" "$2"
  (cd "$WORK/build" && ditto -c -k --keepParent MyApp.app "MyApp-$1.zip")
}

mkdir -p "$WORK/build" "$WORK/proj" "$WORK/installed" "$WORK/static"

# --- 3. init + publish two releases through the real CLI -------------------
cd "$WORK/proj"
log "railcast init"
"$RAILCAST" init --app myapp --token "$RAILCAST_TOKEN" --base-url "$RAILCAST_BASE_URL"
APP_ID="$(python3 -c 'import json;print(json.load(open(".railcast.json"))["app"])')"
PUBKEY="$(curl -fsS -H "Authorization: Bearer $RAILCAST_TOKEN" "$RAILCAST_BASE_URL/api/apps" \
  | python3 -c "import json,sys;print([a for a in json.load(sys.stdin)['apps'] if a['id']=='$APP_ID'][0]['signing_public_key'])")"
FEED="$RAILCAST_BASE_URL/$APP_ID/appcast.xml"
echo "app id: $APP_ID"; echo "public key: $PUBKEY"; echo "feed: $FEED"

publish() { # version build
  build_zip "$1" "$2"
  log "railcast publish $1 (build $2)"
  "$RAILCAST" publish -f "$WORK/build/MyApp-$1.zip" --notes "## What's new in $1"
}
publish 1.0.0 1
publish 1.1.0 2

log "Feed served by Railcast"
curl -fsS "$FEED" | tee "$WORK/feed.xml"
grep -q '<sparkle:shortVersionString>1.1.0<' "$WORK/feed.xml" || fail "feed doesn't offer 1.1.0"
grep -q '<sparkle:minimumSystemVersion>12.0<' "$WORK/feed.xml" \
  || fail "LSMinimumSystemVersion wasn't read from the zipped app (PlistBuddy path) or isn't in the feed"
grep -q 'sparkle:format="markdown"' "$WORK/feed.xml" || fail "release notes aren't marked as markdown"

# --- 4. a real Sparkle client looks at the feed ----------------------------
# `sparkle --probe` exits 0 when an update is available and 4 when there is none
# ("No new update available!", as observed with Sparkle 2.10.0) — anything else
# is an error. It can't be combined with --check-immediately. So each probe pretends
# to be an installed copy with a chosen build number, and the exit code says
# whether the feed it read offers something newer. Builds in play: Railcast has
# 1 and 2 (3 later); the static host offers 9.
probe() { # label installed-build expect(update|none)
  local label="$1" build="$2" expect="$3"
  log "Sparkle probe: $label — installed build $build, expecting: $expect"
  make_app "$WORK/installed" "1.0.$build" "$build" "$FEED" "$PUBKEY"
  set +e
  out="$(perl -e 'alarm shift; exec @ARGV' "$PROBE_TIMEOUT" "$SPARKLE_CLI" "$WORK/installed/MyApp.app" \
    --probe --verbose --grant-automatic-checks --user-agent-name RailcastE2E 2>&1)"
  rc=$?
  set -e
  echo "$out"; echo "(exit code $rc)"
  [ "$rc" -ne 142 ] || fail "Sparkle timed out after ${PROBE_TIMEOUT}s ($label)"
  case "$expect" in
    update) [ "$rc" -eq 0 ] || fail "expected an available update, exit code was $rc ($label)" ;;
    none)   [ "$rc" -eq 4 ] || fail "expected \"no new update\" (exit code 4), got $rc ($label)" ;;
  esac
}

probe "Railcast feed offers build 2 to an installed build 1" 1 update
probe "Railcast feed offers nothing to an installed build 2" 2 none

# --- 5. move the feed: redirect to a static host ---------------------------
# The static feed offers build 9 — something only it has, so a client that
# reports an update for an installed build 2 must have followed the redirect.
cat > "$WORK/static/appcast.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>MyApp (moved)</title>
    <item>
      <title>1.9.0</title>
      <sparkle:version>9</sparkle:version>
      <sparkle:shortVersionString>1.9.0</sparkle:shortVersionString>
      <enclosure url="http://127.0.0.1:$STATIC_PORT/MyApp-1.9.0.zip" length="1" type="application/octet-stream" sparkle:edSignature="AAAA"/>
    </item>
  </channel>
</rss>
XML
python3 -m http.server "$STATIC_PORT" --bind 127.0.0.1 --directory "$WORK/static" > "$WORK/static.log" 2>&1 &
STATIC_PID=$!
for _ in $(seq 1 20); do curl -fsS "http://127.0.0.1:$STATIC_PORT/appcast.xml" >/dev/null 2>&1 && break; sleep 0.5; done

log "railcast redirect --to static host"
"$RAILCAST" redirect --to "http://127.0.0.1:$STATIC_PORT/appcast.xml"

code="$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$FEED")"
echo "GET $FEED -> $code"
[ "$code" = "302 http://127.0.0.1:$STATIC_PORT/appcast.xml" ] || fail "feed doesn't answer 302 to the static host"

probe "after redirect: client must follow it to the static feed (build 9)" 2 update

# a release published while redirected must not change what the client sees
publish 1.2.0 3 >/dev/null
code="$(curl -s -o /dev/null -w '%{http_code}' "$FEED")"
[ "$code" = "302" ] || fail "a new publish broke the redirect (HTTP $code)"

# --- 6. undo ----------------------------------------------------------------
log "railcast redirect --clear"
"$RAILCAST" redirect --clear
code="$(curl -s -o /dev/null -w '%{http_code}' "$FEED")"
[ "$code" = "200" ] || fail "feed should be served again after --clear, got HTTP $code"
curl -fsS "$FEED" | grep -q '<sparkle:shortVersionString>1.2.0<' || fail "after --clear the Railcast feed doesn't offer 1.2.0"
# Installed build 3 is current for Railcast (nothing newer), but the static
# feed's build 9 would still count as an update if the client kept being redirected.
probe "after --clear: back on the Railcast feed, nothing newer than build 3" 3 none

log "ALL CHECKS PASSED"
