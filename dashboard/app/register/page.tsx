"use client";

import { FormEvent, useState } from "react";
import { api, ApiError } from "@/lib/api";

type Status = "idle" | "sending" | "sent" | "error";

export default function RegisterPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setError(null);
    try {
      const res = await api.register(email, password);
      if (res.verification_required) {
        // Brand-new account — no session yet until the confirmation link
        // in the email is clicked.
        setStatus("sent");
      } else {
        // Existing magic-link account attaching a password — already
        // verified, we're logged in immediately.
        window.location.href = "/dashboard";
      }
    } catch (err) {
      setStatus("error");
      setError(err instanceof ApiError ? err.message : "Something went wrong");
    }
  }

  return (
    <main>
      <div className="mb-8">
        <h1 className="text-xl font-semibold tracking-tight">Create your Railcast account</h1>
        <p className="mt-1 text-sm text-ink/60">
          Email and password. We&apos;ll ask you to confirm your email once.
        </p>
      </div>

      <div className="card max-w-sm">
        {status === "sent" ? (
          <div className="text-sm">
            <p className="font-medium text-ink">Check your email</p>
            <p className="mt-1 text-ink/60">
              We sent a confirmation link to <span className="font-mono">{email}</span>. Click it
              to activate your account. It expires in 60 minutes.
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
            <div>
              <label className="label" htmlFor="password">
                Password
              </label>
              <input
                id="password"
                type="password"
                required
                minLength={8}
                placeholder="At least 8 characters"
                className="input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <button type="submit" className="btn w-full" disabled={status === "sending"}>
              {status === "sending" ? "Creating account…" : "Create account"}
            </button>
            {status === "error" && <p className="text-sm text-red-600">{error}</p>}
          </form>
        )}
      </div>

      <p className="mt-6 text-xs text-ink/40">
        Already have an account?{" "}
        <a className="text-accent hover:underline" href="/login">
          Log in
        </a>
      </p>
    </main>
  );
}
