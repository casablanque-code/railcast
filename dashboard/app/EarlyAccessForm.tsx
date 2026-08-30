"use client";

import { FormEvent, useState } from "react";
import { api, ApiError } from "@/lib/api";

type Status = "idle" | "sending" | "sent" | "error";

export function EarlyAccessForm({ buttonLabel }: { buttonLabel: string }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setError(null);
    try {
      await api.requestEarlyAccess(email);
      setStatus("sent");
    } catch (err) {
      setStatus("error");
      setError(err instanceof ApiError ? err.message : "Something went wrong");
    }
  }

  if (status === "sent") {
    return <p className="mt-6 text-sm text-ink/60">Thanks — we&apos;ll be in touch.</p>;
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 flex max-w-sm gap-2">
      <input
        type="email"
        required
        placeholder="you@example.com"
        className="input"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <button type="submit" className="btn shrink-0" disabled={status === "sending"}>
        {status === "sending" ? "Sending…" : buttonLabel}
      </button>
      {status === "error" && <p className="text-sm text-red-600">{error}</p>}
    </form>
  );
}
