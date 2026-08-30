# Railcast

**Sparkle is the updater. Railcast is the backend it needs.**

Sparkle handles the client side of auto-updates on macOS — checking for new versions, downloading, verifying, installing. It deliberately doesn't host anything: the appcast feed, the release files, the signing — that part is on you. In practice that turns into a Supabase Edge Function nobody wants to maintain, an `appcast.xml` hand-edited on a raw GitHub URL, or a full backend built to serve one XML file.

Railcast is that missing piece. Push a build, get back a signed, hosted feed. Nothing to run, nothing to keep alive.

## What you get

- A hosted `appcast.xml` for each app, served fast and cached at the edge
- EdDSA signing built in — every release is verified before Sparkle installs it
- Release channels (stable / beta) out of the box
- A CLI that turns "build → signed, hosted release" into one command

## Who this is for

Solo and small-team macOS developers shipping a native app who want Sparkle's update experience without owning the infrastructure behind it. If you've ever thought "I just need somewhere to put this XML file," this is for you.

## Status

Early — in active development, not yet generally available. WinSparkle and Velopack support (Windows / .NET) are planned once the Sparkle path is proven out.

Interested? Reach out: **casablanque@proton.me**
