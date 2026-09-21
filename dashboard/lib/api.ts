// Same-origin deployment (dashboard is served by the same Worker as the
// API) — relative paths by default. Override for local `next dev` against
// a deployed Worker.
const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    // Most worker endpoints return a plain-text error body (e.g.
    // `new Response("Invalid email or password", { status: 401 })`), not
    // JSON — read as text first and only try to unwrap a {message}/{error}
    // shape on top of that, so plain-text bodies still surface as-is
    // instead of silently falling back to "Request failed (401)".
    const text = await res.text().catch(() => "");
    let message = text.trim() || `Request failed (${res.status})`;
    try {
      const body = JSON.parse(text) as { message?: string; error?: string };
      message = body.message ?? body.error ?? message;
    } catch {
      // not JSON — the raw text is already the message, keep it
    }
    throw new ApiError(res.status, message);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface Me {
  id: string;
  email: string;
}

export interface App {
  id: string; // server-generated, opaque — this is what's in the appcast URL
  name: string; // free-text label you chose, not unique, never in a URL
  signing_public_key: string;
  beta_token: string;
  created_at: number;
}

export interface TokenPreview {
  id: string;
  preview: string;
  app_id: string | null; // null = account-wide (works for every app you own)
  scope: "publish" | "read";
  expires_at: number | null; // null = never expires
  last_used_at: number | null; // null = never used
  created_at: number;
}

export interface CreateTokenOptions {
  app_id?: string; // omit for an account-wide token
  scope?: "publish" | "read"; // defaults to "publish" server-side
  expires_in_days?: number; // omit for a token that never expires
}

export interface Release {
  id: number;
  channel: string;
  version: string;
  build_number: number;
  file_key: string;
  file_size: number;
  sha256: string;
  release_notes: string | null;
  critical: number; // 0 | 1 — D1 has no native boolean
  phased_rollout_interval: number | null;
  created_at: number;
}

export const api = {
  base: API_BASE,
  me: () => request<Me>("/api/me"),
  requestLink: (email: string) =>
    request<{ ok: true; message: string }>("/auth/request", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),
  login: (email: string, password: string) =>
    request<{ ok: true }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  register: (email: string, password: string) =>
    request<{ ok: true; verification_required: boolean }>("/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  listApps: () => request<{ apps: App[] }>("/api/apps"),
  deleteApp: (id: string) => request<void>(`/api/apps/${id}`, { method: "DELETE" }),
  listTokens: () => request<{ tokens: TokenPreview[] }>("/api/tokens"),
  createToken: (options?: CreateTokenOptions) =>
    request<{ id: string; token: string; app_id: string | null; scope: string; expires_at: number | null }>(
      "/api/tokens",
      {
        method: "POST",
        body: JSON.stringify(options ?? {}),
      }
    ),
  deleteToken: (id: string) => request<void>(`/api/tokens/${id}`, { method: "DELETE" }),
  // These two aren't under /api/ — they're the same routes `railcast list`
  // and `railcast cleanup` hit from the CLI (see worker/src/index.ts),
  // authenticated here by the dashboard's session cookie instead of a
  // bearer token. Same data, same rules (e.g. deleting a channel's last
  // release still 409s), no separate copy of anything.
  listReleases: (appId: string) =>
    request<{ app_id: string; app_name: string | null; history_limit: number; releases: Release[] }>(
      `/${appId}/releases`
    ),
  deleteRelease: (appId: string, releaseId: number) =>
    request<void>(`/${appId}/releases/${releaseId}`, { method: "DELETE" }),
};
