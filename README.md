# Railcast

Hosted appcast feeds and update delivery for desktop apps using **Sparkle** (macOS) — no server of your own, built on Cloudflare Workers + R2.

Push a build with one command, get back a signed `appcast.xml` you can drop straight into `SUFeedURL` in `Info.plist`.

## Why this exists

Sparkle is a great free auto-update library, but it deliberately hosts nothing: appcast.xml and the update files themselves are the developer's problem. In practice this turns into homegrown Supabase Edge Functions, appcasts hosted on raw GitHub URLs, and similar duct tape. Railcast covers exactly that piece — feed hosting, file storage, signing, versions, release channels — and leaves all client-side logic to Sparkle itself.

## Architecture

```
 railcast publish  ──►  Cloudflare Worker  ──►  D1 (version metadata)
 (CLI, Go)               (railcast-api)    ──►  R2 (build files)
                               │
                               ▼
                    appcast.xml (served at the edge, cached)
                               │
                               ▼
                    Sparkle client on the user's machine
```

- **`worker/`** — Cloudflare Worker (TypeScript). Serves appcast.xml, accepts file uploads, magic-link auth, JSON API for the dashboard.
- **`cli/`** — Go CLI (`railcast`). Signing key generation, version publishing.
- **`dashboard/`** — Next.js dashboard (static export, deployed as a second Worker serving static assets — no Pages project). Talks to the API Worker's `/api/*` JSON endpoints over the shared `.railcast.casablanque.com` cookie domain.

## Quickstart

### 1. Build the CLI

No prebuilt binaries yet — build from source:

```bash
cd cli
go build -o railcast .
```

### 2. Generate a signing key

```bash
./railcast keygen | tee ~/.railcast/myapp.key
```

This prints an EdDSA key pair. You'll need the **public key** in step 3 when creating the app in the dashboard. Keep the **private key** local and never share it — it's what signs your builds, and if it's compromised, someone else could push a fake update to your users.

### 3. Create an app in the dashboard

1. Go to `https://railcast.casablanque.com/login`, enter your email, click the link you receive.
2. On the dashboard, create an app: pick an `app-id` (letters/digits/hyphens) and paste the public key from step 2.
3. Click "Generate new token" — it's copied to your clipboard automatically and shown **only once**. Save it now.

### 4. Publish your first version

```bash
export RAILCAST_BASE_URL=https://railcast.casablanque.com
export RAILCAST_TOKEN=<token from the dashboard>

./railcast publish \
  --app myapp \
  --file ./build/MyApp-1.0.0.zip \
  --version 1.0.0 \
  --build 1 \
  --key ~/.railcast/myapp.key \
  --notes "First release"
```

The CLI hashes the file (SHA-256), signs it with your private key, uploads it, and registers the version. On success:

```
Published.
  appcast: https://railcast.casablanque.com/myapp/appcast.xml?channel=stable
```

### 5. Wire it up in your app

In your macOS app's `Info.plist` (Sparkle):

```xml
<key>SUFeedURL</key>
<string>https://railcast.casablanque.com/myapp/appcast.xml</string>
<key>SUPublicEDKey</key>
<string>YOUR_PUBLIC_KEY</string>
```

## Release channels

Versions publish to the `stable` channel by default. For beta testing:

```bash
./railcast publish --app myapp --channel beta ...
```

The beta feed is available with a query parameter:
```
https://railcast.casablanque.com/myapp/appcast.xml?channel=beta
```

## API (if you'd rather skip the CLI)

Every endpoint except `appcast.xml` requires an `Authorization: Bearer <token>` header.

| Method | Path | Description |
|---|---|---|
| `GET` | `/:appId/appcast.xml?channel=stable` | Public version feed, no auth required |
| `PUT` | `/:appId/upload/:filename` | Upload a build file to R2 |
| `POST` | `/:appId/versions` | Register a version (after the file upload succeeds) |
| `POST` | `/auth/request` | Send a magic link to an email (`{"email": "..."}`) |
| `GET` | `/auth/verify?token=...` | Confirm login via the link from the email; sets the session cookie and redirects to the dashboard |
| `GET` | `/api/me` | Current logged-in user (cookie session) |
| `GET` | `/api/apps` | List your apps (cookie session) |
| `POST` | `/api/apps` | Create an app: `{"id": "myapp", "signing_public_key": "..."}` (cookie session) |
| `GET` | `/api/tokens` | List your API tokens — only a preview, never the full secret again (cookie session) |
| `POST` | `/api/tokens` | Create a new API token, returned once (cookie session) |

`POST /:appId/versions` request body:
```json
{
  "version": "1.0.0",
  "build_number": 1,
  "channel": "stable",
  "file_key": "myapp/MyApp-1.0.0.zip",
  "file_size": 15420100,
  "sha256": "e3b0c44298fc1c...",
  "signature": "qCtjNcXCLltmU7...",
  "release_notes": "What's new"
}
```

## Local development

```bash
cd worker
npm install
npx wrangler d1 execute railcast --local --file=schema.sql
npx wrangler d1 execute railcast --local --file=migrations/0002_users_and_tokens.sql
npx wrangler d1 execute railcast --local --file=migrations/0003_sessions.sql
npx wrangler dev
```

Local environment variables go in `worker/.dev.vars` (gitignored, see `.gitignore`):
```
RESEND_API_KEY=...
```

### Dashboard

```bash
cd dashboard
npm install
cp .env.example .env.local   # point NEXT_PUBLIC_API_BASE at your Worker
npm run dev
```

Deployed as its own Worker (`dashboard/wrangler.toml`) using [Workers static assets](https://developers.cloudflare.com/workers/static-assets/) — `next build` produces `out/`, which `wrangler deploy` uploads directly, no Pages project involved:

```bash
cd dashboard
npm run deploy   # = next build && wrangler deploy
```

It's on a subdomain that shares the `.railcast.casablanque.com` cookie domain with the API Worker (currently `app.railcast.casablanque.com` — see the `routes` entry in `dashboard/wrangler.toml` and `CORS_ORIGIN` in `worker/wrangler.toml`; update all three together if you rename it).

## Testing

```bash
# Worker — typecheck + integration tests against the real Workers runtime (Miniflare)
cd worker && npm install && npm run typecheck && npm test

# CLI
cd cli && go build ./... && go vet ./... && go test ./...
```

## CI/CD

- **`.github/workflows/test.yml`** — runs on every push/PR: Worker typecheck + vitest, CLI build/vet/test. No deploy step — both Workers (`railcast-api` and `railcast-dashboard`) are connected via [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) (Cloudflare's own git integration) and deploy automatically on push to `main`; each Worker needs its **Root directory** set correctly in its Workers Builds settings (`worker` and `dashboard` respectively) since this is a monorepo.
- **`.github/workflows/release.yml`** — on any `vX.Y.Z` tag push: cross-compiles the CLI for macOS (amd64/arm64), Linux (amd64/arm64), and Windows (amd64), and publishes a GitHub Release with the binaries + `sha256` checksums and an auto-generated changelog.

To cut a release:
```bash
git tag v0.1.0
git push origin v0.1.0
```

## Project status

- [x] appcast.xml generation from D1
- [x] File uploads to R2, EdDSA signing in the CLI
- [x] Magic-link auth, JSON API, dashboard (app creation, token issuance)
- [x] Production deploy on a custom domain
- [x] Worker test suite (Miniflare) + CLI unit tests
- [x] CI (tests) and tag-triggered CLI release builds
- [ ] Live test against a real macOS app using Sparkle
- [ ] WinSparkle support (Windows)
- [ ] Velopack support
- [ ] Billing — Paddle is wired up in an earlier draft of the roadmap, but the plan is now to find a processor that works for an individual (not a legal entity), ideally also usable from the RU market; revisit after the product itself works end-to-end

## Stack

Cloudflare Workers · Cloudflare D1 · Cloudflare R2 · TypeScript · Go · Resend (email) · Sparkle (EdDSA-compatible appcast)
