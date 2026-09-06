"use client";

import { FormEvent, useState } from "react";
import { api, ApiError } from "@/lib/api";

type Status = "idle" | "sending" | "error";

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
      await api.register(email, password);
      window.location.href = "/dashboard";
    } catch (err) {
      setStatus("error");
      setError(err instanceof ApiError ? err.message : "Something went wrong");
    }
  }

  return (
    <main>
      <div className="mb-8">
        <h1 className="text-xl font-semibold tracking-tight">Create your Railcast account</h1>
        <p className="mt-1 text-sm text-ink/60">Email and password — no verification step.</p>
      </div>

      <div className="card max-w-sm">
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
