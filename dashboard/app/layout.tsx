import type { Metadata } from "next";
import "./globals.css";
import { SupportButton } from "./SupportButton";

export const metadata: Metadata = {
  title: "Railcast",
  description: "Hosted appcast feeds and update delivery for Sparkle, WinSparkle, and Velopack.",
};

function RailLogo() {
  return (
    <svg
      width="20"
      height="14"
      viewBox="0 0 20 14"
      fill="none"
      aria-hidden="true"
      className="shrink-0 text-ink"
    >
      <line x1="0" y1="3" x2="20" y2="3" stroke="currentColor" strokeWidth="1.5" />
      <line x1="0" y1="11" x2="20" y2="11" stroke="currentColor" strokeWidth="1.5" />
      <line x1="2" y1="1" x2="2" y2="13" stroke="currentColor" strokeWidth="1.5" />
      <line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" strokeWidth="1.5" />
      <line x1="12" y1="1" x2="12" y2="13" stroke="currentColor" strokeWidth="1.5" />
      <line x1="17" y1="1" x2="17" y2="13" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="mx-auto min-h-screen max-w-3xl px-6 py-10">
          <header className="mb-10 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <a href="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight">
                <RailLogo />
                railcast
              </a>
              <span className="rounded-full border border-line px-1.5 py-0.5 font-mono text-[10px] font-normal text-ink/40">
                v0.4.0
              </span>
            </div>
            <SupportButton />
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
