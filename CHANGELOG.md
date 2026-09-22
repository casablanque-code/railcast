# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(pre-1.0, so minor bumps may still carry breaking changes).

## [0.9.0] - 2026-09-23

### Added
- Web dashboard: each app is now an expandable card listing its releases per channel —
  version, build, size, age, sha256, release notes, and latest/critical/rollout badges —
  with per-release delete and a one-click cleanup for releases that fell out of the
  appcast window. Same routes and rules as `railcast list` / `railcast cleanup`, so the
  web and the CLI never disagree.
- `install.sh` now verifies the downloaded binary's sha256 against the checksum published
  alongside every release before installing anything.
- Per-account caps on apps (50) and API tokens (100), to bound the worst case from a
  compromised or abusive account rather than as a real usage limit.
- Baseline security response headers on every response: CSP, `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, and HSTS
  scoped to the app's own host.
- `SELF-HOSTING.md` — a full walkthrough for running your own instance (D1, R2, Resend,
  deploying the Worker + dashboard, building your own CLI binaries).

### Changed
- The dashboard's session cookie can now authenticate `GET`/`DELETE` on release routes
  (`/:appId/releases`, `/:appId/releases/:id`), gated behind an explicit opt-in on the
  server. Upload and version registration remain bearer-token only.

### Removed
- The hardcoded, never-updated `v0.4.0` version badge in the dashboard header — replaced
  with a link to the GitHub repo.
- The dead `api.createApp` client method (apps are only ever created via `railcast init`).
- Windows support for the CLI. Sparkle only runs on macOS, so publishing from Windows had
  no real use case — dropped the `windows/amd64` release build, `install.ps1`, and every
  Windows-specific install instruction. Version/build auto-detection is unaffected: a
  `.zip` still needs a `.app/Info.plist` to detect from, anything else still requires
  `-v`/`--build`.

### Security
- Tightened the release-route session auth above: it had briefly also accepted the
  session cookie on upload and version registration, which would have let a
  hypothetical XSS on the dashboard publish a build, not just manage existing releases.
- Bumped `sharp` (transitive, via `wrangler`'s dev tooling) and `postcss` (transitive,
  via `next`'s build pipeline) past 4 high-severity advisories, via npm `overrides` —
  neither package ships to a deployed Worker or a browser, but both are now patched.
  `npm audit`: 0 vulnerabilities in both `worker/` and `dashboard/`.

## [0.8.2] - 2026-09-21
### Changed
- General UX polish across the CLI (`publish`, `list`, `cleanup`, `init`).

## [0.8.1] - 2026-09-20
### Added
- `railcast list` (`ls`) and `railcast cleanup` — list releases per app/channel and
  delete the ones that have already fallen out of the appcast's serving window.
- Server-side `history_limit`, returned from the releases endpoint so the CLI's cleanup
  logic can never drift from what `appcast.xml` actually serves.

### Fixed
- A routing bug affecting the new release endpoints.

## [0.8.0] - 2026-09-17
### Added
- Per-token scope selection (`publish` / `read`) in the dashboard's token UI.

## [0.7.0] - 2026-09-17
### Added
- Per-app API tokens, alongside the existing account-wide ones.
- Token expiry (TTL) and scope, enforced server-side.
- Upload size limit, to bound worst-case R2/D1 usage from a single request.

### Fixed
- A race in magic-link / email verification made atomic.
- Assorted worker test fixes.

### Security
- Fixed an XML injection issue in appcast rendering (release notes, version strings).

## [0.6.0] - 2026-09-16
### Fixed
- CI: forced the external linker on macOS to work around a missing `LC_UUID`
  (golang/go#68678) that broke Go builds on recent macOS toolchains.
- CI: CLI tests now also run on `macos-latest`, so the PlistBuddy-dependent
  Info.plist tests actually execute somewhere (they're skipped on Linux).
- `railcast init` test fixes.

### Changed
- Dashboard and landing page UI updates.

## [0.5.0] - 2026-09-07
### Added
- A support/donations button in the dashboard header.

### Changed
- `--build` resolution logic reworked (see README's "Gotchas" section on build-number
  ordering and the per-channel fallback counter).
- Dashboard route fixes and general UI polish.

### Removed
- The early-access landing gate — the project moved to fully open registration.

## [0.4.0] - 2026-09-07
### Added
- Email/password login alongside the existing magic-link flow.
- Required email confirmation for new password sign-ups.
- Checksum verification on published builds (see `X-Sha256` upload flow).
- Copy-to-clipboard buttons across the dashboard.

### Changed
- Transactional email now sent from the verified root domain instead of a subdomain.
- Auth errors from the worker now surface as plain text on the frontend instead of a
  generic failure, and a send failure during registration rolls back cleanly.

### Fixed
- Flaky tests around the Resend email API mocked out properly (no more hitting the
  real network from CI).

## [0.3.2] - 2026-09-02
### Added
- AGPL-3.0 license.
- `sparkle:criticalUpdate` support in the appcast (`--critical` on `railcast publish`).
- Broader test coverage.

### Changed
- CLI flag review/cleanup.

### Removed
- The early-access gate on app creation (later fully removed on the landing page in
  0.5.0).

### Fixed
- A bug affecting apps created with an id that already existed.

## [0.3.1] - 2026-09-02
### Added
- `railcast delete-app` (app deletion from the CLI and dashboard).

### Changed
- Registering a duplicate app name now returns 404 instead of 403, matching the
  ownership-check convention used elsewhere in the API.

## [0.3.0] - 2026-09-01
### Fixed
- Various bug fixes; CI test fixes.

## [0.2.0] - 2026-09-01
### Added
- Token revoke from the dashboard; collapsible release/app lists.
- A CLI demo and trust statement on the landing page.
- One-line install script (`install.sh`).
- Boxed "Publishing plan" output on `railcast publish`, showing exactly what's about to
  be sent and where each value came from.

### Changed
- Cut the CLI's flag surface roughly in half; fixed appcast validator warnings;
  reordered the dashboard around the actual publish flow (install → token → init →
  publish).

### Fixed
- A 404 on magic-link and `appcast.xml` navigation clicks.

## [0.1.1] - 2026-08-30
### Added
- `railcast init` — generates a signing key and registers a new app in one step.
- A dedicated `/login` page; landing page moved to `/`.
- Inline early-access request form on the landing page (later removed in 0.3.2/0.5.0).

### Changed
- README rewritten as product positioning rather than a self-host guide.

## [0.1.0] - 2026-08-30
### Added
- Initial release: appcast.xml generation, signed build upload, `railcast keygen`.
- Version registration endpoint.
- Magic-link auth and the first dashboard.
- Token generation with one-time display and auto-copy to clipboard.
- Deployment pipeline; dashboard merged into the same Worker as the API (one Worker,
  one domain) instead of a separate Cloudflare Pages project.
