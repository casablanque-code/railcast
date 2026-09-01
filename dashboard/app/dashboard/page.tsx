"use client";

import { FormEvent, useEffect, useState } from "react";
import { api, ApiError, type App, type Me, type TokenPreview } from "@/lib/api";

const INLINE_LIMIT = 3;

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString("en-US", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function DashboardPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [apps, setApps] = useState<App[] | null>(null);
  const [tokens, setTokens] = useState<TokenPreview[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [appName, setAppName] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [creatingApp, setCreatingApp] = useState(false);
  const [appError, setAppError] = useState<string | null>(null);

  const [creatingToken, setCreatingToken] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const [deletingAppId, setDeletingAppId] = useState<string | null>(null);
  const [appDeleteError, setAppDeleteError] = useState<string | null>(null);

  async function refresh() {
    const [appsRes, tokensRes] = await Promise.all([api.listApps(), api.listTokens()]);
    setApps(appsRes.apps);
    setTokens(tokensRes.tokens);
  }

  useEffect(() => {
    api
      .me()
      .then((user) => {
        setMe(user);
        return refresh();
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          window.location.href = "/";
          return;
        }
        setLoadError("Couldn't reach the API. Check that the Worker is deployed and reachable.");
      });
  }, []);

  async function onCreateApp(e: FormEvent) {
    e.preventDefault();
    setCreatingApp(true);
    setAppError(null);
    try {
      await api.createApp(appName, publicKey);
      setAppName("");
      setPublicKey("");
      await refresh();
    } catch (err) {
      setAppError(err instanceof ApiError ? err.message : "Couldn't create the app");
    } finally {
      setCreatingApp(false);
    }
  }

  async function onCreateToken() {
    setCreatingToken(true);
    setTokenError(null);
    try {
      const { token } = await api.createToken();
      setNewToken(token);
      navigator.clipboard?.writeText(token).catch(() => {});
      await refresh();
    } catch (err) {
      setTokenError(err instanceof ApiError ? err.message : "Couldn't create the token");
    } finally {
      setCreatingToken(false);
    }
  }

  async function onRevokeToken(id: string) {
    if (!window.confirm("Revoke this token? Anything using it to publish will stop working.")) {
      return;
    }
    setRevokingId(id);
    setTokenError(null);
    try {
      await api.deleteToken(id);
      await refresh();
    } catch (err) {
      setTokenError(err instanceof ApiError ? err.message : "Couldn't revoke the token");
    } finally {
      setRevokingId(null);
    }
  }

  async function onDeleteApp(app: App) {
    if (
      !window.confirm(
        `Delete "${app.name || app.id}"? This removes its appcast feed, published versions, and uploaded builds. Apps that already installed a version keep running it, but Sparkle can no longer check for updates. This can't be undone.`
      )
    ) {
      return;
    }
    setDeletingAppId(app.id);
    setAppDeleteError(null);
    try {
      await api.deleteApp(app.id);
      await refresh();
    } catch (err) {
      setAppDeleteError(err instanceof ApiError ? err.message : "Couldn't delete the app");
    } finally {
      setDeletingAppId(null);
    }
  }

  if (loadError) {
    return (
      <main>
        <p className="text-sm text-red-600">{loadError}</p>
      </main>
    );
  }

  if (!me) {
    return (
      <main>
        <p className="text-sm text-ink/50">Loading…</p>
      </main>
    );
  }

  const appList = apps ?? [];
  const inlineApps = appList.slice(0, INLINE_LIMIT);
  const restApps = appList.slice(INLINE_LIMIT);

  const tokenRow = (t: TokenPreview) => (
    <div
      key={t.id}
      className="flex items-center justify-between border-b border-line pb-3 text-sm last:border-0 last:pb-0"
    >
      <span className="code-chip">{t.preview}</span>
      <div className="flex items-center gap-3">
        <span className="text-ink/50">created {formatDate(t.created_at)}</span>
        <button
          onClick={() => onRevokeToken(t.id)}
          disabled={revokingId === t.id}
          className="text-xs text-red-600 hover:underline disabled:opacity-50"
        >
          {revokingId === t.id ? "Revoking…" : "Revoke"}
        </button>
      </div>
    </div>
  );

  const appRow = (app: App) => (
    <div
      key={app.id}
      className="flex items-center justify-between border-b border-line pb-3 last:border-0 last:pb-0"
    >
      <div>
        <p className="text-sm font-medium">{app.name || "(unnamed)"}</p>
        <p className="mt-0.5 font-mono text-xs text-ink/50">
          {api.base}/{app.id}/appcast.xml
        </p>
      </div>
      <div className="flex items-center gap-4">
        <a
          href={`${api.base}/${app.id}/appcast.xml`}
          target="_blank"
          rel="noreferrer"
          className="code-chip hover:border-accent hover:text-accent"
        >
          open feed
        </a>
        <button
          type="button"
          onClick={() => onDeleteApp(app)}
          disabled={deletingAppId === app.id}
          className="text-xs text-red-600 hover:underline disabled:opacity-50"
        >
          {deletingAppId === app.id ? "Deleting…" : "Delete"}
        </button>
      </div>
    </div>
  );

  return (
    <main className="space-y-10">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-ink/60">{me.email}</p>
        </div>
        <a href={`${api.base}/logout`} className="btn-secondary text-sm">
          Log out
        </a>
      </div>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink/50">
          1. Install the CLI
        </h2>
        <div className="card">
          <pre className="overflow-x-auto rounded-md bg-ink px-4 py-3 font-mono text-xs text-paper">
            curl -fsSL railcast.casablanque.com/install.sh | sh
          </pre>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink/50">
          2. Get a token
        </h2>

        {newToken && (
          <div className="card mb-4 border-accent/30 bg-accent-soft">
            <p className="text-sm font-medium text-ink">
              Token copied to your clipboard — save it now, it won&apos;t be shown again:
            </p>
            <p className="mt-2 break-all font-mono text-sm text-ink">{newToken}</p>
          </div>
        )}

        <div className="mb-4 flex items-center gap-3">
          <button className="btn" onClick={onCreateToken} disabled={creatingToken}>
            {creatingToken ? "Creating…" : "Generate new token"}
          </button>
          {tokenError && <p className="text-sm text-red-600">{tokenError}</p>}
        </div>

        {tokens && tokens.length === 0 ? (
          <p className="text-sm text-ink/50">No tokens yet.</p>
        ) : (
          <details className="card">
            <summary className="cursor-pointer text-sm font-medium text-ink/70">
              Existing tokens ({tokens?.length ?? 0})
            </summary>
            <div className="mt-4 space-y-3">{tokens?.map(tokenRow)}</div>
          </details>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink/50">
          3. Create an app from the CLI
        </h2>
        <div className="card">
          <p className="text-sm text-ink/70">
            This generates a signing key on your machine and registers the app in one step —
            nothing else to fill in here.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-md bg-ink px-4 py-3 font-mono text-xs text-paper">
            railcast init --app myapp --token {newToken ?? "<token from above>"}
          </pre>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink/50">
          Your apps
        </h2>

        {appDeleteError && <p className="mb-3 text-sm text-red-600">{appDeleteError}</p>}

        <div className="card mb-4 space-y-3">
          {appList.length === 0 && (
            <p className="text-sm text-ink/50">
              Nothing yet — apps show up here after <span className="font-mono">railcast init</span>.
            </p>
          )}
          {inlineApps.map(appRow)}
        </div>

        {restApps.length > 0 && (
          <details className="card mb-4">
            <summary className="cursor-pointer text-sm font-medium text-ink/70">
              Show {restApps.length} more app{restApps.length === 1 ? "" : "s"}
            </summary>
            <div className="mt-4 space-y-3">{restApps.map(appRow)}</div>
          </details>
        )}

        <details className="card">
          <summary className="cursor-pointer text-sm font-medium text-ink/70">
            Create an app manually instead
          </summary>
          <form onSubmit={onCreateApp} className="mt-4 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="app-name">
                  App name
                </label>
                <input
                  id="app-name"
                  className="input"
                  placeholder="My Menu Bar App"
                  maxLength={128}
                  required
                  value={appName}
                  onChange={(e) => setAppName(e.target.value)}
                />
                <p className="mt-1 text-xs text-ink/40">
                  Just a label for you — the public feed URL is generated separately and
                  doesn&apos;t need to be unique.
                </p>
              </div>
              <div>
                <label className="label" htmlFor="public-key">
                  Public key (from railcast keygen)
                </label>
                <input
                  id="public-key"
                  className="input font-mono"
                  placeholder="base64…"
                  required
                  value={publicKey}
                  onChange={(e) => setPublicKey(e.target.value)}
                />
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button type="submit" className="btn-secondary" disabled={creatingApp}>
                {creatingApp ? "Creating…" : "Create app"}
              </button>
              {appError && <p className="text-sm text-red-600">{appError}</p>}
            </div>
          </form>
        </details>
      </section>
    </main>
  );
}
