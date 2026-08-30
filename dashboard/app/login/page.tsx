"use client";

import { FormEvent, useState } from "react";
import { api, ApiError } from "@/lib/api";

type Status = "idle" | "sending" | "sent" | "error";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setError(null);
    try {
      await api.requestLink(email);
      setStatus("sent");
    } catch (err) {
      setStatus("error");
      setError(err instanceof ApiError ? err.message : "Something went wrong");
    }
  }

  return (
    <main>
      <div className="mb-8">
        <h1 className="text-xl font-semibold tracking-tight">Log in to Railcast</h1>
        <p className="mt-1 text-sm text-ink/60">
          Hosted appcast feeds and update delivery for Sparkle, WinSparkle, and Velopack.
        </p>
      </div>

      <div className="card max-w-sm">
        {status === "sent" ? (
          <div className="text-sm">
            <p className="font-medium text-ink">Check your email</p>
            <p className="mt-1 text-ink/60">
              We sent a login link to <span className="font-mono">{email}</span>. It expires in
              15 minutes.
            </p>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <label className="label" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                type="email"
                required
                placeholder="you@example.com"
                className="input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <button type="submit" className="btn w-full" disabled={status === "sending"}>
              {status === "sending" ? "Sending…" : "Send login link"}
            </button>
            {status === "error" && <p className="text-sm text-red-600">{error}</p>}
          </form>
        )}
      </div>

      <p className="mt-6 text-xs text-ink/40">
        Already have a link in your inbox?{" "}
        <a className="text-accent hover:underline" href="/dashboard">
          Go to the dashboard
        </a>
      </p>
    </main>
  );
}
