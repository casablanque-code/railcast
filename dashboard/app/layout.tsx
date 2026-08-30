import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Railcast",
  description: "Hosted appcast feeds and update delivery for Sparkle, WinSparkle, and Velopack.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="mx-auto min-h-screen max-w-3xl px-6 py-10">
          <header className="mb-10 flex items-center justify-between">
            <a href="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight">
              <span className="inline-block h-2 w-2 rounded-full bg-accent" />
              railcast
            </a>
            <span className="font-mono text-xs text-ink/40">v0.1.0</span>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
