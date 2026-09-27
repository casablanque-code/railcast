import type { Metadata } from "next";
import "./globals.css";
import { SupportButton } from "./SupportButton";

export const metadata: Metadata = {
  title: "Railcast",
  description:
    "Hosted appcast feeds and update delivery for Sparkle. WinSparkle and Velopack support is planned.",
};

function RailLogo() {
  // Rails converging to a single vanishing point, rather than the previous
  // evenly-spaced ladder (which read as a fence, not a track). Sleeper
  // spacing shrinks and their opacity fades toward the vanishing point —
  // that's what sells the depth at this size; an actual gradient/shadow
  // just turns to mud at 20px.
  return (
    <svg
      width="22"
      height="14"
      viewBox="0 0 26 16"
      fill="none"
      aria-hidden="true"
      className="shrink-0 text-ink"
    >
      <line x1="1" y1="2" x2="25" y2="8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="1" y1="14" x2="25" y2="8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="3.40" y1="2.60" x2="3.40" y2="13.40" stroke="currentColor" strokeWidth="1.3" strokeOpacity="1" />
      <line x1="7.72" y1="3.68" x2="7.72" y2="12.32" stroke="currentColor" strokeWidth="1.3" strokeOpacity="0.85" />
      <line x1="12.52" y1="4.88" x2="12.52" y2="11.12" stroke="currentColor" strokeWidth="1.3" strokeOpacity="0.68" />
      <line x1="17.32" y1="6.08" x2="17.32" y2="9.92" stroke="currentColor" strokeWidth="1.3" strokeOpacity="0.5" />
      <line x1="21.64" y1="7.16" x2="21.64" y2="8.84" stroke="currentColor" strokeWidth="1.3" strokeOpacity="0.32" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="mx-auto min-h-screen max-w-3xl px-6 py-10">
          <header className="mb-10 flex items-center justify-between">
            <a href="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight">
              <RailLogo />
              railcast
            </a>
            <div className="flex items-center gap-4">
              <a
                href="https://github.com/casablanque-code/railcast"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Railcast on GitHub"
                title="View source on GitHub"
                className="text-ink/50 transition hover:text-ink"
              >
                <GitHubIcon />
              </a>
              <SupportButton />
            </div>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
