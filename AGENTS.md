# AGENTS.md

Notes for AI coding agents. Two parts: using Railcast to ship an app, and working on this repository.

## Part 1 — Publishing an app with Railcast

`railcast` (the Go CLI in `cli/`) turns a build into a signed, hosted Sparkle release. `railcast help` and
`railcast publish --help` are the reference; this is what matters for an agent.

**Files in an app's directory — secrets, never print, paste or commit them:**
`.railcast.token` (API token), `<name>.key` (the Ed25519 signing key — it cannot be recovered; losing it
means no more updates for that app), `.railcast.json` (app id, not secret). All three are gitignored.

**Release flow**
1. Build, sign and notarize the app; zip it so the archive contains the `.app`.
2. `railcast publish -f MyApp-1.2.0.zip` — version and build are read from the bundle's `Info.plist`.
   For a `.dmg`/`.pkg` or a zip without an `.app`, pass `-v 1.2.0 -b 42`.
3. Every release needs a **new filename** and a **higher build number** (Sparkle compares build numbers,
   not version strings).
4. Read the "Publishing plan" box it prints before anything is uploaded. Stop if version, build or
   channel look wrong.
5. Verify afterwards: `railcast list` (add `--json` for machine-readable output), then fetch the feed URL.

**Rules for agents**
- Publish to **beta** first (`-c beta`) unless a human says otherwise. There is no `promote` command yet:
  to go stable, publish the same archive to stable under a new filename. Stable goes to every user at
  once, and Sparkle never downgrades — only ship to stable with explicit human approval.
- A bad release is fixed with `railcast yank <version>` (hides it from the feed, reversible with
  `--undo`) plus a new build with a higher build number. Don't delete releases to "fix" things.
- Ask a human before anything destructive or far-reaching: `railcast cleanup`, deleting apps or the
  account, `railcast redirect --to` (sends every installed copy to another feed), `init --import-key`.
- Use the narrowest token: a per-app, publish-scope token for releasing, a read-scope token for
  listing. In CI pass it as `RAILCAST_TOKEN`; self-hosted instances use `RAILCAST_BASE_URL`.
- Release notes (`--notes`, `--notes-file`) are Markdown; text starting with an HTML tag is sent as HTML.

## Part 2 — Working on this repository

**Layout**
- `worker/` — TypeScript Cloudflare Worker (D1 database, R2 bucket), the API and the Sparkle feeds.
- `cli/` — the Go CLI, one `main` package.
- `dashboard/` — Next.js static export, served by the Worker as assets.
- `.github/e2e/`, `.github/workflows/` — CI, including a macOS end-to-end test against a real Sparkle client.

**Check before you finish**
```bash
cd worker    && npm ci && npx tsc --noEmit && npx vitest run
cd cli       && go vet ./... && go test ./...
cd dashboard && npm ci && npx tsc --noEmit && npm run build
```

**Conventions**
- English everywhere: code comments, commit messages, help text, tool output. No other languages in artifacts.
- Small commits with a body that explains why. New behavior comes with tests.
- Keep `README.md`, `SELF-HOSTING.md` and `CHANGELOG.md` (`[Unreleased]`) in step with behavior. If limits
  or stored data change, update `dashboard/app/terms/page.tsx` and `dashboard/app/privacy/page.tsx` too.

**Gotchas that have bitten before**
- A new API path must be listed in `run_worker_first` in `worker/wrangler.toml`, or the assets layer answers
  405 to non-GET requests. The Worker's own tests can't see this; the e2e and `wrangler dev` can.
- A new migration needs the matching DDL in `worker/test/setup.ts`. Apply migrations before deploying a Worker
  that needs them.
- After changing what a feed serves, purge it: `purgeAppcastCache` (the stable feed is edge-cached for 60 s).
- `.gitignore` ignores `*.sh`, `*.patch`, `*.zip`, `.railcast.*` and more — `git add -A` silently skips them.
  `git status` after adding, and use `git add -f` or a negation in `.gitignore`.
- Go 1.22 links darwin binaries without `LC_UUID`, which current macOS refuses to run. Release builds use a
  current Go and CI checks the Mach-O header.
- Security invariants: the server never sees a private signing key; API tokens, sessions and rate-limit buckets
  are stored hashed; never log or store raw IPs or emails in the rate limiter.
