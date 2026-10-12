"use client";

import { useEffect, useState } from "react";
import { api, ApiError, type App, type Me, type Release, type TokenPreview } from "@/lib/api";
import { goTo } from "@/lib/nav";
import { CommandBlock } from "../CommandBlock";
import { CopyButton } from "../CopyButton";

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

  const [creatingToken, setCreatingToken] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [tokenScope, setTokenScope] = useState<"publish" | "read">("publish");
  const [tokenAppId, setTokenAppId] = useState<string>(""); // "" = account-wide
  const [tokenExpiryDays, setTokenExpiryDays] = useState<string>(""); // "" = never

  const [deletingAppId, setDeletingAppId] = useState<string | null>(null);
  const [appDeleteError, setAppDeleteError] = useState<string | null>(null);

  const [expandedAppId, setExpandedAppId] = useState<string | null>(null);
  const [releasesByApp, setReleasesByApp] = useState<Record<string, Release[]>>({});
  const [releasesLoading, setReleasesLoading] = useState<string | null>(null);
  const [releasesError, setReleasesError] = useState<Record<string, string>>({});
  const [deletingReleaseKey, setDeletingReleaseKey] = useState<string | null>(null);
  const [yankingKey, setYankingKey] = useState<string | null>(null);

  const [redirectInput, setRedirectInput] = useState<Record<string, string>>({});
  const [redirectBusy, setRedirectBusy] = useState<string | null>(null);
  const [redirectError, setRedirectError] = useState<Record<string, string>>({});
  const [exportFilesUrl, setExportFilesUrl] = useState<Record<string, string>>({});
  const [exportBusy, setExportBusy] = useState<string | null>(null);
  const [exportError, setExportError] = useState<Record<string, string>>({});

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteEmail, setDeleteEmail] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function loadReleases(appId: string) {
    setReleasesLoading(appId);
    setReleasesError((prev) => ({ ...prev, [appId]: "" }));
    try {
      const res = await api.listReleases(appId);
      setReleasesByApp((prev) => ({ ...prev, [appId]: res.releases }));
    } catch (err) {
      setReleasesError((prev) => ({
        ...prev,
        [appId]: err instanceof ApiError ? err.message : "Couldn't load releases",
      }));
    } finally {
      setReleasesLoading((cur) => (cur === appId ? null : cur));
    }
  }

  // One app's releases open at a time, loaded on demand — this is the same
  // data `railcast list` prints, just fetched lazily here instead of on
  // every dashboard load, since most apps have more releases than anyone
  // wants to see by default.
  function toggleReleases(appId: string) {
    if (expandedAppId === appId) {
      setExpandedAppId(null);
      return;
    }
    setExpandedAppId(appId);
    if (!releasesByApp[appId]) {
      loadReleases(appId);
    }
  }

  async function onDeleteRelease(appId: string, release: Release) {
    if (
      !window.confirm(
        `Delete ${release.version} (build ${release.build_number}, ${release.channel})? Anyone still ` +
          `on this exact build keeps running it, but Sparkle can no longer offer it as an update. ` +
          `This can't be undone.`
      )
    ) {
      return;
    }
    const key = `${appId}:${release.id}`;
    setDeletingReleaseKey(key);
    setReleasesError((prev) => ({ ...prev, [appId]: "" }));
    try {
      await api.deleteRelease(appId, release.id);
      setReleasesByApp((prev) => ({
        ...prev,
        [appId]: (prev[appId] ?? []).filter((r) => r.id !== release.id),
      }));
    } catch (err) {
      // Most likely a 409: "can't delete the only release on this channel"
      // — surfaced as-is, it's already written for a human to read.
      setReleasesError((prev) => ({
        ...prev,
        [appId]: err instanceof ApiError ? err.message : "Couldn't delete the release",
      }));
    } finally {
      setDeletingReleaseKey((cur) => (cur === key ? null : cur));
    }
  }

  // Yank hides a release from the feed without deleting it (reversible) —
  // `railcast yank` from the CLI. Sparkle never downgrades, so the confirm
  // spells out who this does and doesn't help.
  async function onToggleYank(appId: string, release: Release) {
    const yank = release.yanked !== 1;
    if (
      yank &&
      !window.confirm(
        `Hide ${release.version} (build ${release.build_number}, ${release.channel}) from the feed? ` +
          `New update checks get the previous release again. Anyone who already installed it stays on it — ` +
          `Sparkle never downgrades — so ship a fix with a higher build number too. You can restore it any time.`
      )
    ) {
      return;
    }
    const key = `${appId}:${release.id}`;
    setYankingKey(key);
    setReleasesError((prev) => ({ ...prev, [appId]: "" }));
    try {
      if (yank) await api.yankRelease(appId, release.id);
      else await api.unyankRelease(appId, release.id);
      setReleasesByApp((prev) => ({
        ...prev,
        [appId]: (prev[appId] ?? []).map((r) => (r.id === release.id ? { ...r, yanked: yank ? 1 : 0 } : r)),
      }));
    } catch (err) {
      // 409: "can't yank the only live release on this channel" — already readable.
      setReleasesError((prev) => ({
        ...prev,
        [appId]: err instanceof ApiError ? err.message : "Couldn't change the release",
      }));
    } finally {
      setYankingKey((cur) => (cur === key ? null : cur));
    }
  }

  async function onSetRedirect(app: App, target: string | null) {
    if (
      target !== null &&
      !window.confirm(
        `Send every installed copy of "${app.name || app.id}" to ${target}? Their update checks will be ` +
          `redirected there instead of this feed. That feed has to be signed with the same key. You can ` +
          `undo this here at any time.`
      )
    ) {
      return;
    }
    setRedirectBusy(app.id);
    setRedirectError((prev) => ({ ...prev, [app.id]: "" }));
    try {
      await api.setFeedRedirect(app.id, target);
      setRedirectInput((prev) => ({ ...prev, [app.id]: "" }));
      await refresh();
    } catch (err) {
      setRedirectError((prev) => ({
        ...prev,
        [app.id]: err instanceof ApiError ? err.message : "Couldn't change the redirect",
      }));
    } finally {
      setRedirectBusy(null);
    }
  }

  // Downloads releases.json-equivalent data (every release with signatures and
  // hashes, plus ready-made appcasts when a files URL is given). The files
  // themselves come from `railcast export` — a browser shouldn't pull gigabytes.
  async function onExport(app: App) {
    setExportBusy(app.id);
    setExportError((prev) => ({ ...prev, [app.id]: "" }));
    try {
      const filesUrl = (exportFilesUrl[app.id] ?? "").trim();
      const data = await api.exportApp(app.id, filesUrl || undefined);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = `${app.id}-export.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(href);
    } catch (err) {
      setExportError((prev) => ({
        ...prev,
        [app.id]: err instanceof ApiError ? err.message : "Couldn't export",
      }));
    } finally {
      setExportBusy(null);
    }
  }

  async function onDeleteAccount() {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await api.deleteAccount(deleteEmail);
      goTo("/");
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : "Couldn't delete the account");
      setDeleteBusy(false);
    }
  }

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
          goTo("/");
          return;
        }
        setLoadError("Couldn't reach the API. Check that the Worker is deployed and reachable.");
      });
  }, []);

  async function onCreateToken() {
    setCreatingToken(true);
    setTokenError(null);
    try {
      const { token } = await api.createToken({
        app_id: tokenAppId || undefined,
        scope: tokenScope,
        expires_in_days: tokenExpiryDays ? Number(tokenExpiryDays) : undefined,
      });
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
      setReleasesByApp((prev) => {
        const { [app.id]: _drop, ...rest } = prev;
        return rest;
      });
      if (expandedAppId === app.id) setExpandedAppId(null);
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

  const tokenRow = (t: TokenPreview) => {
    const scopedApp = t.app_id ? appList.find((a) => a.id === t.app_id) : null;
    const isExpired = t.expires_at !== null && t.expires_at * 1000 < Date.now();

    return (
      <div
        key={t.id}
        className="flex items-center justify-between gap-4 border-b border-line pb-3 text-sm last:border-0 last:pb-0"
      >
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="code-chip">{t.preview}</span>
            <span
              className={`rounded px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide ${
                t.scope === "read" ? "bg-ink/5 text-ink/60" : "bg-accent-soft text-accent"
              }`}
            >
              {t.scope}
            </span>
            {isExpired && (
              <span className="rounded bg-red-50 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-red-600">
                expired
              </span>
            )}
          </div>
          <p className="text-xs text-ink/50">
            {t.app_id ? `scoped to ${scopedApp?.name || t.app_id}` : "works for every app you own"}
            {" · "}
            {t.expires_at ? `expires ${formatDate(t.expires_at)}` : "never expires"}
            {" · "}
            {t.last_used_at ? `last used ${formatDate(t.last_used_at)}` : "never used"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
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
  };

  const releaseRow = (appId: string, r: Release) => {
    const key = `${appId}:${r.id}`;
    return (
      <div
        key={r.id}
        className="flex items-center justify-between gap-4 border-b border-line pb-2 text-sm last:border-0 last:pb-0"
      >
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-ink">
              {r.version} <span className="text-ink/40">· build {r.build_number}</span>
            </span>
            <span className="rounded bg-ink/5 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-ink/60">
              {r.channel}
            </span>
            {r.yanked === 1 && (
              <span
                className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-amber-700"
                title="Hidden from the appcast — use Restore to bring it back"
              >
                yanked
              </span>
            )}
            {r.critical === 1 && (
              <span className="rounded bg-red-50 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-red-600">
                critical
              </span>
            )}
            {r.phased_rollout_interval ? (
              <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-accent">
                phased/{r.phased_rollout_interval}s
              </span>
            ) : null}
          </div>
          <p className="truncate text-xs text-ink/40" title={r.sha256}>
            {formatDate(r.created_at)} · {(r.file_size / (1024 * 1024)).toFixed(1)} MB · sha256{" "}
            {r.sha256.slice(0, 12)}…
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <button
            type="button"
            onClick={() => onToggleYank(appId, r)}
            disabled={yankingKey === key}
            aria-label={`${r.yanked === 1 ? "Restore" : "Yank"} ${r.version} (${r.channel})`}
            className="text-xs text-ink/60 hover:text-accent hover:underline disabled:opacity-50"
            title={
              r.yanked === 1
                ? "Put this release back into the feed"
                : "Hide this release from the feed without deleting it"
            }
          >
            {yankingKey === key ? "…" : r.yanked === 1 ? "Restore" : "Yank"}
          </button>
          <button
            type="button"
            onClick={() => onDeleteRelease(appId, r)}
            disabled={deletingReleaseKey === key}
            aria-label={`Delete release ${r.version} (${r.channel})`}
            className="text-xs text-red-600 hover:underline disabled:opacity-50"
          >
            {deletingReleaseKey === key ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    );
  };

  const appRow = (app: App) => {
    const expanded = expandedAppId === app.id;
    const releases = releasesByApp[app.id];

    return (
      <div key={app.id} className="border-b border-line pb-3 last:border-0 last:pb-0">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">{app.name || "(unnamed)"}</p>
            <p className="mt-0.5 font-mono text-xs text-ink/50">
              {api.base}/{app.id}/appcast.xml
            </p>
            {app.feed_redirect_url && (
              <p className="mt-1 break-all text-xs text-amber-700">
                Feed redirects to <span className="font-mono">{app.feed_redirect_url}</span>
              </p>
            )}
          </div>
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => toggleReleases(app.id)}
              className="code-chip hover:border-accent hover:text-accent"
            >
              {expanded ? "hide releases" : "releases"}
            </button>
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

        {expanded && (
          <div className="mt-3 rounded-lg border border-line bg-ink/[0.02] p-3">
            {releasesError[app.id] && (
              <p className="mb-2 text-xs text-red-600">{releasesError[app.id]}</p>
            )}
            {releasesLoading === app.id && !releases ? (
              <p className="text-xs text-ink/50">Loading releases…</p>
            ) : releases && releases.length === 0 ? (
              <p className="text-xs text-ink/50">
                No releases yet — <span className="font-mono">railcast publish</span> from the CLI to
                add one.
              </p>
            ) : (
              <div className="space-y-2">{releases?.map((r) => releaseRow(app.id, r))}</div>
            )}

            <div className="mt-4 space-y-5 border-t border-line pt-4">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-ink/50">Move the feed</h3>
                <p className="mt-1 text-xs text-ink/50">
                  Installed copies keep asking this feed&apos;s URL. Send them to a new host (HTTP 302) without
                  shipping a release. The new feed must be signed with the same key. The CLI,{" "}
                  <span className="font-mono">railcast redirect</span>, also checks that the target looks like an
                  appcast first; here that&apos;s on you.
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    className="input min-w-0 flex-1"
                    placeholder="https://updates.example.com/appcast.xml"
                    value={redirectInput[app.id] ?? ""}
                    onChange={(e) => setRedirectInput((prev) => ({ ...prev, [app.id]: e.target.value }))}
                  />
                  <button
                    type="button"
                    className="btn"
                    disabled={redirectBusy === app.id || !(redirectInput[app.id] ?? "").trim()}
                    onClick={() => onSetRedirect(app, (redirectInput[app.id] ?? "").trim())}
                  >
                    {redirectBusy === app.id ? "Saving…" : "Redirect"}
                  </button>
                  {app.feed_redirect_url && (
                    <button
                      type="button"
                      className="btn-secondary text-sm"
                      disabled={redirectBusy === app.id}
                      onClick={() => onSetRedirect(app, null)}
                    >
                      Clear redirect
                    </button>
                  )}
                </div>
                {redirectError[app.id] && <p className="mt-2 text-xs text-red-600">{redirectError[app.id]}</p>}
              </div>

              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-ink/50">Export</h3>
                <p className="mt-1 text-xs text-ink/50">
                  Download every release with its signature and hash, plus ready-made feeds for the host you give
                  below. The files themselves come from the CLI:
                </p>
                <CommandBlock
                  className="mt-2"
                  command={`railcast export --app ${app.id} --out ./export --files-url https://updates.example.com/files`}
                />
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    className="input min-w-0 flex-1"
                    placeholder="Files URL for the feeds (optional): https://updates.example.com/files"
                    value={exportFilesUrl[app.id] ?? ""}
                    onChange={(e) => setExportFilesUrl((prev) => ({ ...prev, [app.id]: e.target.value }))}
                  />
                  <button
                    type="button"
                    className="btn-secondary text-sm"
                    disabled={exportBusy === app.id}
                    onClick={() => onExport(app)}
                  >
                    {exportBusy === app.id ? "Exporting…" : "Download JSON"}
                  </button>
                </div>
                {exportError[app.id] && <p className="mt-2 text-xs text-red-600">{exportError[app.id]}</p>}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

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
        <div className="card space-y-2">
          <CommandBlock command="curl -fsSL railcast.casablanque.com/install.sh | sh" />
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
            <div className="mt-2 flex items-start justify-between gap-3">
              <p className="break-all font-mono text-sm text-ink">{newToken}</p>
              <CopyButton
                text={newToken}
                className="mt-0.5 text-ink/40 hover:bg-ink/5 hover:text-ink"
              />
            </div>
          </div>
        )}

        <div className="card mb-4 space-y-4">
          <p className="text-xs text-ink/50">
            By default a token can publish to every app you own and never expires — narrow it down
            if you&apos;re handing it to CI or a script that only needs one app, or only needs to
            read release info.
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className="label">Scope</label>
              <select
                className="input"
                value={tokenScope}
                onChange={(e) => setTokenScope(e.target.value as "publish" | "read")}
              >
                <option value="publish">Publish (upload &amp; manage)</option>
                <option value="read">Read-only (list releases)</option>
              </select>
            </div>
            <div>
              <label className="label">App</label>
              <select className="input" value={tokenAppId} onChange={(e) => setTokenAppId(e.target.value)}>
                <option value="">All apps (account-wide)</option>
                {appList.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name || a.id}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Expires</label>
              <select
                className="input"
                value={tokenExpiryDays}
                onChange={(e) => setTokenExpiryDays(e.target.value)}
              >
                <option value="">Never</option>
                <option value="7">In 7 days</option>
                <option value="30">In 30 days</option>
                <option value="90">In 90 days</option>
                <option value="365">In 1 year</option>
              </select>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button className="btn" onClick={onCreateToken} disabled={creatingToken}>
              {creatingToken ? "Creating…" : "Generate new token"}
            </button>
            {tokenError && <p className="text-sm text-red-600">{tokenError}</p>}
          </div>
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
          <CommandBlock
            className="mt-3"
            command={`railcast init --app myapp --token ${newToken ?? "<token from above>"}`}
          />
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink/50">
          4. Publish
        </h2>
        <div className="card">
          <p className="text-sm text-ink/70">
            Run this from the same directory as <span className="font-mono">init</span> — it
            picks up the app and key automatically.
          </p>
          <CommandBlock className="mt-3" command="railcast publish -f myapp-1.0.0.zip" />
        </div>
        <p className="mt-3 text-xs text-ink/50">
          No <span className="font-mono">-v</span>/<span className="font-mono">--version</span> or{" "}
          <span className="font-mono">-b</span>/<span className="font-mono">--build</span> needed —
          for a <span className="font-mono">.zip</span> containing a signed <span className="font-mono">.app</span>,
          Railcast reads them straight from its own <span className="font-mono">Info.plist</span>. Publishing
          a <span className="font-mono">.dmg</span>/<span className="font-mono">.pkg</span>, or a
          plain <span className="font-mono">.zip</span> with no <span className="font-mono">.app</span> inside?
          Then there&apos;s nothing to detect, so pass both yourself:{" "}
          <span className="font-mono">-v 1.2.0 -b 42</span>. Either way, updating later just means a{" "}
          <span className="font-mono">new filename</span> (like{" "}
          <span className="font-mono">myapp-1.0.1.zip</span>) — Railcast keeps every uploaded
          filename permanently attached to its release, so reusing one fails.
        </p>
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
          {appList.length > 0 && (
            <p className="text-xs text-ink/50">
              Click <span className="font-mono">releases</span> on an app to see its published builds,
              yank or delete them, move its feed to another host, or export everything — the same things{" "}
              <span className="font-mono">railcast list</span>, <span className="font-mono">yank</span>,{" "}
              <span className="font-mono">redirect</span>, <span className="font-mono">export</span> and{" "}
              <span className="font-mono">cleanup</span> do from the CLI.
            </p>
          )}
          {inlineApps.map(appRow)}
        </div>

        {restApps.length > 0 && (
          <details className="card">
            <summary className="cursor-pointer text-sm font-medium text-ink/70">
              Show {restApps.length} more app{restApps.length === 1 ? "" : "s"}
            </summary>
            <div className="mt-4 space-y-3">{restApps.map(appRow)}</div>
          </details>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink/50">Danger zone</h2>
        <div className="card space-y-3">
          <p className="text-sm text-ink/70">
            Delete your account and everything under it: apps, releases, uploaded builds, tokens. Feeds stop
            answering; apps that are already installed keep running but can no longer find updates. This can&apos;t
            be undone — export what you need first.
          </p>
          {!deleteOpen ? (
            <button type="button" className="btn-secondary text-sm text-red-600" onClick={() => setDeleteOpen(true)}>
              Delete account…
            </button>
          ) : (
            <div className="space-y-2">
              <label htmlFor="delete-account-email" className="block text-xs text-ink/50">
                Type your email (<span className="font-mono">{me.email}</span>) to confirm
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  id="delete-account-email"
                  className="input min-w-0 flex-1"
                  value={deleteEmail}
                  onChange={(e) => setDeleteEmail(e.target.value)}
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="btn"
                  disabled={deleteBusy || deleteEmail.trim().toLowerCase() !== me.email.toLowerCase()}
                  onClick={onDeleteAccount}
                >
                  {deleteBusy ? "Deleting…" : "Delete everything"}
                </button>
                <button
                  type="button"
                  className="btn-secondary text-sm"
                  disabled={deleteBusy}
                  onClick={() => {
                    setDeleteOpen(false);
                    setDeleteEmail("");
                    setDeleteError(null);
                  }}
                >
                  Cancel
                </button>
              </div>
              {deleteError && <p className="text-xs text-red-600">{deleteError}</p>}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
