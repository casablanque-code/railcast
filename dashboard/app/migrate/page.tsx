import type { Metadata } from "next";
import { CommandBlock } from "../CommandBlock";

export const metadata: Metadata = {
  title: "Switching from your own updater — Railcast",
  description:
    "Move an app that already ships updates with Sparkle — or with a hand-rolled updater — to Railcast, without locking yourself in.",
};

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-line py-6">
      <h2 className="text-sm font-semibold">
        <span className="mr-2 font-mono text-ink/40">{n}.</span>
        {title}
      </h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-ink/70">{children}</div>
    </section>
  );
}

const code = (s: string) => <span className="font-mono text-xs text-ink">{s}</span>;

export default function MigratePage() {
  return (
    <main>
      <h1 className="text-xl font-semibold tracking-tight">Switching from your own updater</h1>
      <p className="mt-3 text-sm leading-relaxed text-ink/70">
        Already shipping updates with Sparkle from your own server, S3 or GitHub Pages? You can move to
        Railcast without releasing a new version of your app first: installed copies keep trusting the
        signing key they already have. You need a Railcast account, an API token (in the dashboard) and
        the CLI:
      </p>
      <div className="mt-3">
        <CommandBlock command="curl -fsSL railcast.casablanque.com/install.sh | sh" />
      </div>

      <div className="mt-6">
        <Step n={1} title="Export your signing key">
          <p>
            Sparkle keeps it in your Keychain. Export it with the tool from Sparkle&apos;s {code("bin/")}{" "}
            folder:
          </p>
          <CommandBlock command="./generate_keys -x sparkle_private_key" />
          <p>
            That file is your private key. It stays on your machine — Railcast never receives it, only the
            public half.
          </p>
        </Step>

        <Step n={2} title="Create the app with that key">
          <CommandBlock command="railcast init --app myapp --import-key sparkle_private_key --token <token>" />
          <p>
            The CLI prints {code("SUPublicEDKey")}. It must be identical to the one in your shipping
            app&apos;s {code("Info.plist")} — if it isn&apos;t, you exported the wrong key. Your original
            key file is left alone; a copy in Railcast&apos;s format is saved as {code("myapp.key")}.
          </p>
        </Step>

        <Step n={3} title="Publish your current release">
          <CommandBlock command='railcast publish -f MyApp-1.4.0.zip --notes "What changed"' />
          <p>
            Publish the newest build you have. Older builds aren&apos;t needed: Sparkle offers the newest
            build to anyone on an older version, so Railcast doesn&apos;t import your release history.
          </p>
        </Step>

        <Step n={4} title="Send installed copies to the new feed">
          <p>
            Installed apps keep asking the feed URL they shipped with. Move them in one of two ways:
          </p>
          <ul className="list-disc space-y-2 pl-5">
            <li>
              <span className="font-medium text-ink">You control the old feed URL.</span> Make it answer
              with a redirect (HTTP 301 or 302) to your Railcast feed — the CLI prints it as{" "}
              {code("SUFeedURL")} after {code("init")}. Nothing to ship: copies follow the redirect at
              their next update check.
            </li>
            <li>
              <span className="font-medium text-ink">You don&apos;t.</span> Release one last update from
              your old feed whose {code("Info.plist")} has {code("SUFeedURL")} set to the Railcast feed.
              Everyone who installs it gets their updates from Railcast from then on.
            </li>
          </ul>
          <p>
            Rehearse with a throwaway app and a test build first; the beta channel ({code("--channel beta")}
            ) is handy for that.
          </p>
        </Step>
      </div>

      <section className="border-t border-line py-6">
        <h2 className="text-sm font-semibold">Hand-rolled updater, not Sparkle?</h2>
        <p className="mt-3 text-sm leading-relaxed text-ink/70">
          Railcast serves Sparkle feeds for macOS apps, so the app needs Sparkle first — a normal app
          update. Add Sparkle, create the app without importing anything ({code("railcast init --app myapp")}
          generates a fresh key), put the {code("SUFeedURL")} and {code("SUPublicEDKey")} it prints into
          your {code("Info.plist")}, and ship that version through your current mechanism. From then on,
          updates go through Railcast.
        </p>
      </section>

      <section className="border-t border-line py-6">
        <h2 className="text-sm font-semibold">Not locked in</h2>
        <p className="mt-3 text-sm leading-relaxed text-ink/70">
          Changed your mind later? {code("railcast export")} downloads every release, signature and a
          ready-made feed, and {code("railcast redirect")} sends installed apps to your own host again — no
          new release needed.
        </p>
      </section>
    </main>
  );
}
