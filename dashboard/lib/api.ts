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
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      message = body.message ?? body.error ?? message;
    } catch {
      // response wasn't JSON — keep the generic message
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
  listApps: () => request<{ apps: App[] }>("/api/apps"),
  createApp: (name: string, signingPublicKey: string) =>
    request<App>("/api/apps", {
      method: "POST",
      body: JSON.stringify({ name, signing_public_key: signingPublicKey }),
    }),
  deleteApp: (id: string) => request<void>(`/api/apps/${id}`, { method: "DELETE" }),
  listTokens: () => request<{ tokens: TokenPreview[] }>("/api/tokens"),
  createToken: () => request<{ id: string; token: string }>("/api/tokens", { method: "POST" }),
  deleteToken: (id: string) => request<void>(`/api/tokens/${id}`, { method: "DELETE" }),
};
