"use client";

import { FormEvent, useState } from "react";
import { api, ApiError } from "@/lib/api";

type Mode = "password" | "link";
type Status = "idle" | "sending" | "sent" | "error";

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  function switchMode(next: Mode) {
    setMode(next);
    setStatus("idle");
    setError(null);
  }

  async function onSubmitPassword(e: FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setError(null);
    try {
      await api.login(email, password);
      window.location.href = "/dashboard";
    } catch (err) {
      setStatus("error");
      setError(err instanceof ApiError ? err.message : "Something went wrong");
    }
  }

  async function onSubmitLink(e: FormEvent) {
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
          Hosted appcast feeds and update delivery for Sparkle. WinSparkle and Velopack support
          is planned.
        </p>
      </div>

      <div className="card max-w-sm">
        <div className="mb-4 flex gap-4 text-sm">
          <button
            type="button"
            onClick={() => switchMode("password")}
            className={mode === "password" ? "font-medium text-ink" : "text-ink/50 hover:text-ink"}
          >
            Password
          </button>
          <button
            type="button"
            onClick={() => switchMode("link")}
            className={mode === "link" ? "font-medium text-ink" : "text-ink/50 hover:text-ink"}
          >
            Email link
          </button>
        </div>

        {mode === "link" && status === "sent" ? (
          <div className="text-sm">
            <p className="font-medium text-ink">Check your email</p>
            <p className="mt-1 text-ink/60">
              We sent a login link to <span className="font-mono">{email}</span>. It expires in
              15 minutes.
            </p>
          </div>
        ) : (
          <form onSubmit={mode === "password" ? onSubmitPassword : onSubmitLink} className="space-y-4">
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
            {mode === "password" && (
              <div>
                <label className="label" htmlFor="password">
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  required
                  placeholder="••••••••"
                  className="input"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            )}
            <button type="submit" className="btn w-full" disabled={status === "sending"}>
              {status === "sending"
                ? mode === "password"
                  ? "Logging in…"
                  : "Sending…"
                : mode === "password"
                  ? "Log in"
                  : "Send login link"}
            </button>
            {status === "error" && <p className="text-sm text-red-600">{error}</p>}
          </form>
        )}
      </div>

      <p className="mt-6 text-xs text-ink/40">
        No account yet?{" "}
        <a className="text-accent hover:underline" href="/register">
          Create one
        </a>
      </p>
    </main>
  );
}
