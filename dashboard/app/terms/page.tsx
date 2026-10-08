import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms — Railcast",
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

export default function TermsPage() {
  return (
    <main>
      <h1 className="text-xl font-semibold tracking-tight">Terms</h1>
      <p className="mt-3 text-sm leading-relaxed text-ink/70">
        Railcast hosts update feeds and release files for macOS apps. It is run
        by one person. By using it you agree to the points below.
      </p>

      <div className="mt-6">
        <Section title="The service">
          Provided as is — no uptime guarantee and no support contract. It can
          change or go away. You can always take your releases with you (
          <span className="font-mono">railcast export</span>) and point
          installed apps at a new host (
          <span className="font-mono">railcast redirect</span>
          ).
        </Section>

        <Section title="What you can upload">
          Only software you have the right to distribute. No malware, nothing
          illegal, nothing that infringes someone else&apos;s rights. Railcast
          serves your files from a domain that carries this project&apos;s name,
          which is why this one matters.
        </Section>

        <Section title="Your responsibility">
          You are responsible for the updates you ship to your users. Your
          signing key stays on your machine: Railcast never has it and
          can&apos;t sign anything for you. Lose it, and nobody can publish
          updates for that app.
        </Section>

        <Section title="Limits and abuse">
          Fair-use limits apply: 500 MiB per file, 5 GiB of releases per
          account, 60 uploads per hour, 50 apps and 100 tokens. I may remove
          releases or suspend accounts that break these terms or abuse the
          service — without notice if it&apos;s urgent.
        </Section>

        <Section title="Reporting something">
          Found something hosted here that is harmful or infringes your rights?
          Email{" "}
          <a href={`mailto:${CONTACT}`} className="underline hover:text-ink">
            {CONTACT}
          </a>{" "}
          with the feed or file URL. I&apos;ll look at it and remove it if it
          breaks these terms.
        </Section>

        <Section title="Liability">
          To the extent the law allows, Railcast comes without warranties, and
          I&apos;m not liable for damages from using it or from it being
          unavailable.
        </Section>

        <Section title="Changes">
          I may update these terms; the date below changes when I do.
        </Section>
      </div>

      <div className="border-t border-line pt-6 text-sm leading-relaxed text-ink/70">
        <p>
          Complaint, question, suggestion — or just want to say something? Feel
          free to reach out:{" "}
          <a href={`mailto:${CONTACT}`} className="underline hover:text-ink">
            {CONTACT}
          </a>
        </p>
        <p className="mt-3 text-xs text-ink/40">
          Last updated: October 8, 2026 · See also the{" "}
          <a href="/privacy" className="underline hover:text-ink">
            privacy notes
          </a>
          .
        </p>
      </div>
    </main>
  );
}
