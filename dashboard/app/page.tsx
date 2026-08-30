import type { Metadata } from "next";
import { EarlyAccessForm } from "./EarlyAccessForm";

export const metadata: Metadata = {
  title: "Railcast — the backend Sparkle needs",
};

export default function LandingPage() {
  return (
    <main>
      <section className="py-6">
        <h1 className="text-2xl font-semibold leading-snug tracking-tight sm:text-3xl">
          Sparkle is the updater.
          <br />
          Railcast is the backend it needs.
        </h1>
        <p className="mt-4 max-w-lg text-sm leading-relaxed text-ink/60">
          Push a build, get back a signed, hosted <span className="font-mono">appcast.xml</span>.
          Nothing to run, nothing to keep alive.
        </p>
        <EarlyAccessForm buttonLabel="Get early access" />
      </section>

      <section className="border-t border-line py-10">
        <ul className="space-y-5">
          <li>
            <p className="text-sm font-medium">Sparkle ships the update. It doesn&apos;t host it.</p>
            <p className="mt-1 text-sm text-ink/55">
              The feed, the files, the signing — that part has always been on you.
            </p>
          </li>
          <li>
            <p className="text-sm font-medium">The usual fix is duct tape.</p>
            <p className="mt-1 text-sm text-ink/55">
              A Supabase function nobody wants to touch again, or an{" "}
              <span className="font-mono">appcast.xml</span> hand-edited on a raw GitHub URL.
            </p>
          </li>
          <li>
            <p className="text-sm font-medium">Railcast is that missing piece.</p>
            <p className="mt-1 text-sm text-ink/55">Nothing else about your app changes.</p>
          </li>
        </ul>
      </section>

      <section className="border-t border-line py-10">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink/50">How it works</h2>
        <ol className="mt-5 space-y-5">
          <li className="flex gap-4">
            <span className="font-mono text-xs text-ink/35">01</span>
            <p className="text-sm text-ink/75">Create an account and get a token.</p>
          </li>
          <li className="flex gap-4">
            <span className="font-mono text-xs text-ink/35">02</span>
            <p className="text-sm text-ink/75">
              Publish from the CLI — it signs and uploads your build.
            </p>
          </li>
          <li className="flex gap-4">
            <span className="font-mono text-xs text-ink/35">03</span>
            <p className="text-sm text-ink/75">Sparkle finds it. Your users update.</p>
          </li>
        </ol>
      </section>

      <section className="border-t border-line py-10">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink/50">Signing</h2>
        <ul className="mt-5 space-y-3 text-sm text-ink/70">
          <li>Every release is signed with EdDSA before Sparkle will install it.</li>
          <li>
            Your private signing key is generated and kept on your own machine — it never touches
            our servers.
          </li>
        </ul>
      </section>

      <section className="border-t border-line py-10">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink/50">Pricing</h2>
        <p className="mt-4 text-sm text-ink/70">Early access. Pricing announced soon.</p>
        <EarlyAccessForm buttonLabel="Request access" />
      </section>

      <footer className="border-t border-line py-8 text-xs text-ink/40">
        <p>
          In active development. casablanque@proton.me ·{" "}
          <a href="/login" className="hover:text-ink/70 hover:underline">
            Already have access? Log in
          </a>
        </p>
      </footer>
    </main>
  );
}
