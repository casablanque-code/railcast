# Self-hosting Railcast

Railcast is AGPL-3.0 and built entirely on Cloudflare's serverless primitives —
Workers, D1, R2 — so running your own instance means creating your own copies
of those, not standing up a server. This guide walks through it end to end.

If you just want to use Railcast, you don't need any of this — sign up at
[railcast.casablanque.com](https://railcast.casablanque.com) instead. This is
for running your own, fully independent instance.

## What you'll need

- A Cloudflare account (the free tier covers this comfortably)
- A domain (or subdomain) you control, added to that Cloudflare account
- [`wrangler`](https://developers.cloudflare.com/workers/wrangler/) — installed
  automatically via `npx wrangler`, no global install needed
- Node.js 20+ and Go 1.22+ (only if you also want to build the CLI yourself —
  see [Building your own CLI binaries](#building-your-own-cli-binaries))
- A [Resend](https://resend.com) account (free tier is enough) for
  transactional email — magic links and email verification go through it

## 1. Clone and log in

```bash
git clone https://github.com/casablanque-code/railcast
cd railcast/worker
npx wrangler login
```

## 2. Create your Cloudflare resources

```bash
npx wrangler d1 create railcast
npx wrangler r2 bucket create railcast-builds
```

Each command prints an id (D1's `database_id`) or confirms the bucket name.
You'll need the D1 `database_id` in the next step.

## 3. Configure `wrangler.toml`

Open `worker/wrangler.toml` and change:

- `routes[0].pattern` — your own domain, e.g. `railcast.yourdomain.com`
- `d1_databases[0].database_id` — the id from `wrangler d1 create` above
- `vars.PUBLIC_FILE_BASE_URL` — see step 4, you'll fill this in once the R2
  bucket has a public domain
- `vars.MAX_UPLOAD_BYTES` — optional, defaults to 500 MiB per upload if unset
- `vars.STORAGE_QUOTA_BYTES` — optional, total size of published releases one
  account may keep; defaults to 5 GiB

`r2_buckets[0].bucket_name` should already match what you created in step 2;
change it there too if you picked a different name.

## 4. Give the R2 bucket a public domain

Published builds are downloaded straight from R2 by Sparkle clients, so the
bucket needs a domain of its own (separate from the API's domain in step 3).
In the Cloudflare dashboard: **R2 → railcast-builds → Settings → Custom
Domains**, and attach something like `dl.yourdomain.com`. Put that URL into
`PUBLIC_FILE_BASE_URL` in `wrangler.toml`.

(R2's own `r2.dev` subdomain works too for testing, but a custom domain is
what you want for anything real — `r2.dev` is rate-limited and meant for
quick checks, not production traffic.)

## 5. Run the database migrations

```bash
npx wrangler d1 migrations apply railcast --remote
```

This applies everything under `worker/migrations/` in order (the numbering has
gaps on purpose: 0002–0006 were folded into `0001_initial.sql`). Use
`--local` instead if you want to run the Worker locally first (see
[Running locally](#running-locally)) before ever touching the remote database.

## 6. Set your Resend API key

```bash
npx wrangler secret put RESEND_API_KEY
```

Paste your Resend API key when prompted. This is what sends magic-link and
email-verification mail — grab a key from your Resend dashboard.

By default, mail is sent from `onboarding@resend.dev` (Resend's shared
sandbox address — works immediately, no setup, but looks exactly like what
it is). If you want mail to come from your own domain instead, verify a
domain in Resend and change the `from:` address in
`worker/src/index.ts` (search for `onboarding@resend.dev`) before deploying.

## 7. Build the dashboard and deploy

The dashboard is a static Next.js export, served as the Worker's static
assets — there's no separate deploy step for it.

```bash
cd ../dashboard
npm ci
npm run build          # writes dashboard/out — worker/wrangler.toml already
                        # points [assets].directory at ../dashboard/out
cd ../worker
npx wrangler deploy
```

That's it — visit your domain, sign up, and you should land on a working
dashboard. The deploy also registers the nightly cleanup cron from
`[triggers]` in `wrangler.toml` (see below).

## Terms, privacy and contact

The dashboard ships `/terms` and `/privacy` pages and a footer with a contact
address — they describe the hosted instance (its limits, its email provider,
its contact). If you run your own, edit `dashboard/app/terms/page.tsx`,
`dashboard/app/privacy/page.tsx` and the footer in `dashboard/app/layout.tsx`
to match your instance before you open registration to other people,
especially if you serve files to the public from your domain.

## Upgrading an existing instance

Pull the new code, then **apply migrations first, deploy second** — a new
Worker talking to an old schema fails on the missing columns:

```bash
git pull
cd worker
npx wrangler d1 migrations apply railcast --remote
cd ../dashboard && npm ci && npm run build && cd ../worker
npx wrangler deploy
```

`CHANGELOG.md` says which release needs which migration.

## Running locally

For development, before touching anything remote:

```bash
cd worker
npx wrangler d1 migrations apply railcast --local
npx wrangler dev
```

`wrangler dev` runs the Worker (API + dashboard) against local D1/R2
emulation. You'll still need a real `RESEND_API_KEY` if you want to actually
receive magic-link emails locally — everything else works offline.

## Building your own CLI binaries

You don't have to build the CLI yourself — the published `railcast`
binaries work against any backend via `--base-url` or the
`RAILCAST_BASE_URL` environment variable:

```bash
export RAILCAST_BASE_URL=https://railcast.yourdomain.com
railcast init --app myapp --token <token from your dashboard>
```

Build your own only if you want `install.sh`/your own release artifacts to
point at your domain by default, or you don't trust a binary you didn't
build:

```bash
cd cli
go build -ldflags "-X main.version=$(git describe --tags --always)" -o railcast .
```

If you want the default base URL (no `--base-url` needed) to be your own
domain, change `defaultBaseURL` in `cli/config.go` before building.

`.github/workflows/release.yml` shows how the upstream project cuts binaries
for macOS (amd64/arm64) and Linux (amd64/arm64) from a git tag, sha256s them,
and attaches them to a GitHub Release, if you want to mirror that for your
own fork.

## Things that are yours to configure, not covered above

- **Rate limits, app/token caps** — the `rateLimited(...)` calls throughout
  `worker/src/index.ts` (magic-link requests, registration, login) and the
  `MAX_APPS_PER_ACCOUNT` / `MAX_TOKENS_PER_ACCOUNT` constants near the top
  of the file are hardcoded, not configurable via `wrangler.toml`. Defaults
  are tuned for a small public instance; edit them directly in the source
  if you're running this for a large team or want it stricter.
- **Storage quota and the nightly cleanup** — `STORAGE_QUOTA_BYTES` in `wrangler.toml`
  caps the total size of published releases per account (default 5 GiB), uploads are
  limited to 60/hour per account (`MAX_UPLOADS_PER_HOUR` in the source), and the cron
  trigger under `[triggers]` runs a nightly sweep that deletes R2 objects which were
  uploaded but never registered as a release (older than `ORPHAN_MIN_AGE_SECONDS`,
  default 24 h). Keep the cron if you keep the bucket public.
- **Edge caching of the public feed** — the Worker caches the stable
  `appcast.xml` for 60 seconds with the Cache API (and purges it on publish,
  yank and delete). The Cache API only works on routes attached to your own
  domain, as in step 3 — on a `workers.dev` address it silently does nothing,
  which is harmless, just uncached.
- **CORS/Origin checks** — `hasValidOrigin()` compares against the request's
  own `Host`, so it adapts to whatever domain you deploy to automatically —
  nothing to change here.
- **Backups** — D1 has point-in-time recovery on Cloudflare's side, but
  consider `wrangler d1 export` on a schedule if you want your own copy.
  R2 has no built-in versioning; enable
  [R2 bucket versioning](https://developers.cloudflare.com/r2/buckets/bucket-versioning/)
  if you want protection against accidental overwrites/deletes beyond what
  Railcast's own immutability check (re-uploading to an already-published
  `file_key` 409s) gives you.

## Leaving, or moving between hosts

Nothing is locked in. `railcast export --app <id> --out <dir> --files-url <url>`
downloads all releases, signatures and a ready-made appcast from any instance
(yours or the hosted one), and `railcast redirect --to <new feed url>` makes the
old feed URL send installed apps to the new one. See the README section
"Taking your releases with you" for the details.

## Getting help

Self-hosting is supported on a best-effort basis — open an issue on the
[GitHub repo](https://github.com/casablanque-code/railcast) if something in
this guide doesn't work. Pull requests improving it are welcome.
