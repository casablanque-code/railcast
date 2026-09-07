"use client";

import { useEffect, useRef, useState } from "react";

const USDT_ADDRESS = "0x3bE6114bc999482843bde238F4e17997B5355F76";

const LINKS = [
  { label: "Patreon", href: "https://patreon.com/casablanque" },
  { label: "Ko-fi", href: "https://ko-fi.com/casablanque" },
  { label: "CloudTips", href: "https://pay.cloudtips.ru/p/18fa81b4" },
];

export function SupportButton() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(USDT_ADDRESS);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard API unavailable — the address is still selectable/visible
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="text-xs text-ink/50 transition hover:text-ink"
      >
        Support ♥
      </button>

      {open && (
        <div className="card absolute right-0 top-full z-10 mt-2 w-60 p-3 shadow-md">
          <p className="label mb-2">Support Railcast</p>
          <ul className="space-y-0.5">
            {LINKS.map((link) => (
              <li key={link.href}>
                <a
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block rounded px-2 py-1.5 text-sm text-ink transition hover:bg-paper"
                >
                  {link.label}
                </a>
              </li>
            ))}
          </ul>

          <div className="mt-2 border-t border-line pt-2">
            <p className="px-2 text-sm text-ink">USDT</p>
            <p className="px-2 text-xs text-ink/50">Avalanche C-Chain only</p>
            <button
              type="button"
              onClick={copyAddress}
              className="mt-1.5 block w-full rounded border border-line px-2 py-1.5 text-left font-mono text-xs text-ink/70 transition hover:bg-paper"
              title={USDT_ADDRESS}
            >
              {copied ? "Copied!" : `${USDT_ADDRESS.slice(0, 10)}…${USDT_ADDRESS.slice(-6)}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
