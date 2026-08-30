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
      setError(err instanceof ApiError ? err.message : "Что-то пошло не так");
    }
  }

  return (
    <main>
      <div className="mb-8">
        <h1 className="text-xl font-semibold tracking-tight">Войти в Railcast</h1>
        <p className="mt-1 text-sm text-ink/60">
          Хостинг appcast-фидов и доставка апдейтов для Sparkle, WinSparkle и Velopack.
        </p>
      </div>

      <div className="card max-w-sm">
        {status === "sent" ? (
          <div className="text-sm">
            <p className="font-medium text-ink">Проверь почту</p>
            <p className="mt-1 text-ink/60">
              Мы отправили ссылку для входа на <span className="font-mono">{email}</span>. Ссылка
              действует 15 минут.
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
              {status === "sending" ? "Отправляю…" : "Прислать ссылку для входа"}
            </button>
            {status === "error" && <p className="text-sm text-red-600">{error}</p>}
          </form>
        )}
      </div>

      <p className="mt-6 text-xs text-ink/40">
        Уже есть ссылка на почте?{" "}
        <a className="text-accent hover:underline" href="/dashboard">
          Перейти в дашборд
        </a>
      </p>
    </main>
  );
}
