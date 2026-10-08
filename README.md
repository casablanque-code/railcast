# Railcast

**Sparkle is the updater. Railcast is the backend it needs.**

Sparkle handles the client side of auto-updates on macOS — checking for new versions, downloading, verifying, installing. It deliberately doesn't host anything: the appcast feed, the release files, the signing — that part is on you. In practice that turns into a Supabase Edge Function nobody wants to maintain, an `appcast.xml` hand-edited on a raw GitHub URL, or a full backend built to serve one XML file.

Railcast is that missing piece. Push a build, get back a signed, hosted feed. Nothing to run, nothing to keep alive.

## What you get

- A hosted `appcast.xml` for each app, served fast and cached at the edge
- EdDSA signing happens on your machine: Railcast never sees your private key, so even a full compromise of the server can't produce an update your users' Sparkle will accept
- Release channels (stable / beta) out of the box
- A CLI that turns "build → signed, hosted release" into one command
- Pull a broken release without deleting anything (`railcast yank`)
- No lock-in: `railcast export` hands you every file, signature and a ready-made feed, and
  `railcast redirect` moves already-installed apps to your own host without a new release
- A web dashboard for your apps, tokens and release history — the same list and delete as
  `railcast list` / `railcast cleanup` (yank, export and redirect are CLI-only for now)

## Who this is for

Solo and small-team macOS developers shipping a native app who want Sparkle's update experience without owning the infrastructure behind it. If you've ever thought "I just need somewhere to put this XML file," this is for you.

## Quick start

1. **Create an account** — [railcast.casablanque.com/register](https://railcast.casablanque.com/register), email + password. Confirm the email that gets sent; that link also logs you in.
2. **Get a token** — on the dashboard, under "Get a token", click **Generate new token**. It's shown once and copied to your clipboard automatically — save it somewhere, it can't be viewed again (you can always revoke it and generate a new one).
3. **Install the CLI**:
   ```bash
   curl -fsSL railcast.casablanque.com/install.sh | sh
   ```
   It verifies the download's sha256 against the checksum published alongside every release
   binary before installing anything — a corrupted download or a tampered mirror gets rejected,
   not silently installed.
4. **Set your token for the session** (optional, but every command below assumes it):
   ```bash
   export RAILCAST_TOKEN=<token from step 2>
   ```

## Publishing a new app

From the directory where your build lives:

```bash
railcast init --app testapp
```

This generates an Ed25519 signing key, registers a new app on the server, and saves two things in the current directory:
- `testapp.key` — your **private** signing key (mode `0600`). Never share it, never commit it. Losing it means you can no longer publish updates for this app — there's no recovery.
- `.railcast.json` — the app's real (server-generated) id and the path to the key. `railcast publish` reads this automatically from now on, so you don't need to pass `--app`/`--key` again as long as you run `publish` from this same directory.

`init` also prints an `SUFeedURL` and `SUPublicEDKey` — add both to your app's `Info.plist` once, so Sparkle knows where to check for updates and which key to trust.

Then publish the first build:

```bash
railcast publish -f testapp-1.0.0.zip
```

`-v`/`--version` and `-b`/`--build` are both optional for a `.zip` — Railcast reads
`CFBundleShortVersionString` and `CFBundleVersion` straight out of the `.app`'s own `Info.plist`
inside the archive, so there's nothing to type or keep in sync by hand. Before touching the
network, `publish` prints exactly what it resolved and where each value came from, so you can
double check:
```
┌─ Publishing plan ──────────────────────────
│ file:    testapp-1.0.0.zip
│ app:     a1b2c3d4e5f6
│ channel: stable
│ version: 1.0.0 (detected from Info.plist)
│ build:   42 (detected from Info.plist)
│ sha256:  9f3a...
└────────────────────────────────────────────
```

## Already shipping with Sparkle?

Installed copies only trust the `SUPublicEDKey` they shipped with, so reuse your existing key instead of generating a new one:

```bash
# 1. Export the key Sparkle keeps in your Keychain (from Sparkle's bin/ folder):
./generate_keys -x sparkle_private_key
# 2. Register it with Railcast:
railcast init --app myapp --import-key sparkle_private_key
```

The export is a 32-byte seed, and Railcast reads it directly — CI checks this against Sparkle's own `generate_keys` and `sign_update` (same key, same file, identical signature). The key is copied to `myapp.key` in Railcast's format; your original file is left alone. `init` prints `SUPublicEDKey` — it must equal the one already in your shipping app's `Info.plist`, otherwise it's the wrong key. Then ship **one last release from your old feed** that changes `SUFeedURL` to the Railcast URL; from then on, publish with Railcast.

## Updating an existing app

From the same directory (so `.railcast.json` is picked up):

```bash
railcast publish -f testapp-2.0.0.zip
```

Bump `CFBundleShortVersionString`/`CFBundleVersion` in Xcode like you normally would before archiving — Railcast picks up whatever's actually in the zip, every time. There's no separate number to remember to bump on the Railcast side.

- The archive file must still have a **name Railcast hasn't seen before** for this app (see Gotchas below) — the filename itself has to change every release, bumping the version alone does not satisfy this. Baking the version into the filename (as above) is the simplest way to guarantee that.
- If you do pass `--version`/`--build` explicitly, they override whatever's in the zip. An explicit `--build` still has to be **strictly greater** than the previous build on that channel — the server rejects anything else.
- For a `.dmg`/`.pkg` (or a `.zip` with no `.app` inside, or with a non-numeric `CFBundleVersion`), auto-detection isn't possible — pass `--version` explicitly, and see the Gotchas note on `--build` below.

Optional flags for either a first publish or an update:

| Flag | Short | Purpose |
|---|---|---|
| `--build <n>` | `-b` | Explicit build number, overriding what's detected from the archive (or Railcast's own auto-assign, if detection isn't possible). Must be greater than the channel's current latest — see Gotchas. |
| `--channel beta` | `-c` | Publishes to a separate channel instead of `stable`. Build-number ordering is tracked per channel, independently. |
| `--notes "…"` | | Markdown (or plain text) release notes, shown in Sparkle's update dialog. Notes that start with an HTML tag are sent as HTML instead. Markdown rendering needs Sparkle 2.9+ and macOS 12+; older clients show the raw text. |
| `--notes-file path` | | Same, read from a file — overrides `--notes` if both are given. |
| `--min-system-version <v>` | | Lowest macOS version the build runs on, e.g. `13.0` (`sparkle:minimumSystemVersion`). Detected from `LSMinimumSystemVersion` in the `.app`'s `Info.plist` for a `.zip`. |
| `--critical` | | Marks the update as critical (`sparkle:criticalUpdate`) — Sparkle won't let the user postpone it. |
| `--phased-rollout <seconds>` | | Staggers the rollout to installed clients (`sparkle:phasedRolloutInterval`). `0` (default) disables it. |

`--file`/`-f`, `--version`/`-v`, `--app`/`-a`, `--key`/`-k`, and `--token`/`-t` all have the same
short forms shown earlier. Run `railcast publish --help` any time for the full, current flag list.

## Pulling a bad release

```bash
railcast yank 1.4.2            # hide it from the feed, keep the file
railcast yank 1.4.2 --undo     # bring it back
```

New update checks get the previous release again. Sparkle never downgrades, so anyone who already installed the bad build stays on it until you publish a fix with a **higher build number**. `railcast list` marks yanked releases; `railcast cleanup` never deletes them. The only live release on a channel can't be yanked.

## Taking your releases with you

Railcast is run by one person, so nothing about your releases is locked in here.

**1. Export** everything:

```bash
railcast export --app myapp --out ./export --files-url https://updates.myapp.com/files
```

Downloads every release file (checked against its recorded sha256), writes `releases.json` (signatures, hashes, notes) and a ready-made `appcast.xml` (plus `appcast-beta.xml` etc.) pointing at `--files-url`. Upload `export/files/` to any static host and serve the XML there.

**2. Redirect** installed apps to it:

```bash
railcast redirect --to https://updates.myapp.com/appcast.xml
```

Installed copies keep asking the feed URL they shipped with. After this, that URL answers with a redirect (302) to the new feed, so they follow you without a new release. Railcast fetches the target first and refuses it unless it looks like an appcast (`--force` overrides). Keep the new feed signed with the same key — installed copies still trust the `SUPublicEDKey` they shipped with. The beta channel follows too if the URL ends in `/appcast.xml` (it maps to `appcast-beta.xml` next to it). Undo with `railcast redirect --clear`; `railcast redirect` alone shows the current state. CI checks this with a real Sparkle client (the update check of Sparkle's own command-line updater follows the redirect, and the feed comes back after `--clear`), but try it with a throwaway app before relying on it for a real one.

## Gotchas

- **Upload filenames are permanent per app.** Once `appid/filename` has a published version attached, that exact filename can never be re-uploaded for that app — it's intentional (nothing should be able to silently swap the bytes behind an already-signed, already-published release). If you get `"...zip" was already published for this app`, the fix is to rename the archive, not to change `--version`/`--build`. Baking the version into the filename up front avoids ever hitting this.
- **`--build`/`--version` are detected from the archive, not tracked by Railcast.** For a `.zip`, Railcast reads `CFBundleShortVersionString`/`CFBundleVersion` straight from the `.app`'s own `Info.plist` inside it — the same values already baked into what's running on someone's Mac, so there's no separate counter that can drift out of sync. This only works for `.zip` archives with a `.app` inside and a numeric `CFBundleVersion`; anything else (`.dmg`/`.pkg`, or a `.zip` where detection fails) falls back to a per-app, per-channel counter Railcast maintains itself (starting at `1`, `stable` and `beta` independent) — pass `--version` explicitly in that case, and see the next point for `--build`.
- **If you're relying on Railcast's own counter (the fallback above), it doesn't know about builds you shipped before adopting Railcast.** Sparkle compares the appcast's build number against the installed app's own `CFBundleVersion` — if that's already at, say, `42` from your own tooling, and Railcast's counter starts fresh at `1`, existing users would never see the update (`1 < 42`). This isn't a concern if `.zip` auto-detection is working (see above) — it always reflects the real `CFBundleVersion`, so it can't fall behind. It only matters for `.dmg`/`.pkg` or undetectable `.zip`s: set a floor once, at `init` time — `railcast init --app myapp --initial-build 42` — and the counter starts at `43` instead. Forgot, and the app already exists? Pass an explicit `--build` higher than your last real one for the next publish; the counter picks up from there afterwards.
- **The signing key never touches the server.** `init` generates it locally (or imports yours with `--import-key`) and only ever uploads the *public* half. If `<app>.key` is lost, there is no way to publish further updates to that app under the same `SUPublicEDKey`: installed copies would reject anything signed with a different key, so those users would have to download the new app by hand. Back the key up.
- **`publish` checks your key before uploading.** It verifies the fresh signature and compares the key's public half with the one registered for the app; a mismatch (wrong `--key` file) stops the publish instead of producing a feed Sparkle would silently reject. The server itself does not verify signatures — it only checks sha256 and size.
- **The public feed is cached at the edge for up to 60 seconds.** A release you just published (or yanked) is visible immediately in the data center you published from, and within a minute everywhere else. Beta feeds are never cached.
- **Limits on the hosted instance:** 500 MiB per file, 5 GiB of published releases per account, 60 uploads per hour, 50 apps and 100 tokens per account. Uploads that never get registered as a release are deleted by a nightly sweep after 24 hours. Delete old releases (`railcast cleanup`) to free space.
- **`--app` at `init` time is just a local label** — it picks the default key filename and shows up in your terminal, but the id Railcast actually uses (in the feed URL, in `--app` for `publish`) is a separate, server-generated id written into `.railcast.json`. You don't need it to be unique across all Railcast users.
- **Publishing from a different machine or directory** (no local `.railcast.json`/key) means passing `--app <id>` and `--key <path>` explicitly to `publish` — copy both from wherever `init` originally ran. Don't run `init` again for an app you already have; that creates a brand-new app with a brand-new key, not a continuation of the old one.
- **Beta channel feeds are unlisted, not private.** `railcast init` prints a feed URL like `.../appcast.xml?channel=beta&token=<beta_token>` — anyone with that URL can read the beta feed, there's no per-user auth on it. Treat the URL itself as the secret; it's not shown again after `init`, but you can find the current one on the dashboard.
- **Tokens can be account-wide or scoped to one app, and to publish-or-read**, set at creation
  time (dashboard: the "Get a token" form; CLI: not creatable from the CLI itself, only from the
  dashboard). A leaked token only ever exposes what it was actually scoped to — prefer a
  narrowly-scoped one for CI. Revoke it from the dashboard immediately if it leaks; publishing
  continues to work for anyone with a different valid token.
- **Self-hosting**: override the API base URL with `--base-url` or `$RAILCAST_BASE_URL` if you're not using the hosted instance.

## Status

In active development. macOS / Sparkle only.

Free and open source under [AGPL-3.0](./LICENSE) — [self-host it](./SELF-HOSTING.md), or use the
hosted instance at [railcast.casablanque.com](https://railcast.casablanque.com). No account
gating, no paid tier. Donations are welcome but never required — see the site for links.

The hosted instance is run by one person. That is why export and redirect exist: if it ever
goes away, your releases and your installed apps can leave with you.

[Terms](https://railcast.casablanque.com/terms) and [privacy notes](https://railcast.casablanque.com/privacy)
for the hosted instance are short and in plain language. Complaint, question, suggestion — or just
want to say something? Feel free to reach out: casablanque@proton.me

Questions or bugs: **casablanque@proton.me**
