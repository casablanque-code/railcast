import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy — Railcast",
};

const CONTACT = "casablanque@proton.me";

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-line py-6">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-ink/50">
        {title}
      </h2>
      <p className="mt-3 text-sm leading-relaxed text-ink/70">{children}</p>
    </section>
  );
}

export default function PrivacyPage() {
  return (
    <main>
      <h1 className="text-xl font-semibold tracking-tight">Privacy</h1>
      <p className="mt-3 text-sm leading-relaxed text-ink/70">
        Short version: Railcast stores what it needs to run your feeds, and
        nothing else.
      </p>

      <div className="mt-6">
        <Section title="What is stored">
          Your email address and your password (only as a salted hash, never the
          password itself); a login cookie; your API tokens (only a hash and the
          first few characters, plus when each was last used); your apps — name,
          public signing key, beta feed token — and your releases: metadata,
          notes and the files you upload.
        </Section>

        <Section title="Short-lived data">
          Counters that limit login and upload attempts are kept as hashes of
          the IP address or email involved, and deleted within a day.
        </Section>

        <Section title="What is not done">
          No analytics, no tracking, no ads, no selling or sharing of data.
          Railcast itself doesn&apos;t record who fetches a feed or downloads a
          release.
        </Section>

        <Section title="Who else is involved">
          Cloudflare hosts everything (Workers, D1 and R2) and, like any host,
          sees request metadata such as IP addresses. Resend delivers the emails
          — verification and login links.
        </Section>

        <Section title="Your data">
          Take your releases and signatures any time with{" "}
          <span className="font-mono">railcast export</span>. Delete releases
          from the dashboard or the CLI. To delete your account and everything
          under it, email me and I&apos;ll do it — there&apos;s no self-service
          button yet.
        </Section>
      </div>

      <div className="border-t border-line pt-6 text-sm leading-relaxed text-ink/70">
        <p>
          Questions, concerns, requests — feel free to reach out:{" "}
          <a href={`mailto:${CONTACT}`} className="underline hover:text-ink">
            {CONTACT}
          </a>
        </p>
        <p className="mt-3 text-xs text-ink/40">
          Last updated: October 8, 2026 · See also the{" "}
          <a href="/terms" className="underline hover:text-ink">
            terms
          </a>
          .
        </p>
      </div>
    </main>
  );
}
