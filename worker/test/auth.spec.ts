import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "./setup";

describe("POST /auth/request", () => {
  it("rejects a missing email without touching the email provider", async () => {
    const res = await SELF.fetch("https://railcast.test/auth/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("rejects invalid JSON", async () => {
    const res = await SELF.fetch("https://railcast.test/auth/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /auth/register", () => {
  it("rejects a short password", async () => {
    const res = await SELF.fetch("https://railcast.test/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `${crypto.randomUUID()}@example.com`, password: "short" }),
    });
    expect(res.status).toBe(400);
  });

  it("creates an unverified user, sends no session cookie yet, and stores a verification token", async () => {
    const email = `${crypto.randomUUID()}@example.com`;
    const res = await SELF.fetch("https://railcast.test/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "correct-horse-battery" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    const body = await res.json<{ ok: true; verification_required: boolean }>();
    expect(body.verification_required).toBe(true);

    const user = await env.DB.prepare(
      `SELECT password_hash, email_verified FROM users WHERE email = ?`
    )
      .bind(email)
      .first<{ password_hash: string; email_verified: number }>();
    expect(user?.password_hash).toBeTruthy();
    expect(user?.email_verified).toBe(0);

    const verification = await env.DB.prepare(
      `SELECT count(*) as c FROM email_verifications ev
       JOIN users u ON u.id = ev.user_id
       WHERE u.email = ? AND ev.used = 0`
    )
      .bind(email)
      .first<{ c: number }>();
    expect(verification?.c).toBe(1);
  });

  it("rejects registering an email that already has a password", async () => {
    const email = `${crypto.randomUUID()}@example.com`;
    const first = await SELF.fetch("https://railcast.test/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "correct-horse-battery" }),
    });
    expect(first.status).toBe(200);

    const second = await SELF.fetch("https://railcast.test/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "another-password" }),
    });
    expect(second.status).toBe(409);
  });

  it("lets a magic-link-only account attach a password and log in immediately", async () => {
    // A row created via the magic-link flow is already verified (see
    // /auth/verify), so attaching a password shouldn't need re-confirmation.
    const userId = crypto.randomUUID();
    const email = `${crypto.randomUUID()}@example.com`;
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO users (id, email, email_verified, created_at) VALUES (?, ?, 1, ?)`
    )
      .bind(userId, email, now)
      .run();

    const res = await SELF.fetch("https://railcast.test/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "correct-horse-battery" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toContain("session=");
    const body = await res.json<{ verification_required: boolean }>();
    expect(body.verification_required).toBe(false);

    const row = await env.DB.prepare(`SELECT id, password_hash FROM users WHERE email = ?`)
      .bind(email)
      .first<{ id: string; password_hash: string }>();
    expect(row?.id).toBe(userId);
    expect(row?.password_hash).toBeTruthy();
  });
});

describe("GET /auth/verify-email", () => {
  it("400s on a missing token", async () => {
    const res = await SELF.fetch("https://railcast.test/auth/verify-email");
    expect(res.status).toBe(400);
  });

  it("400s on an unknown token", async () => {
    const res = await SELF.fetch(
      "https://railcast.test/auth/verify-email?token=does-not-exist"
    );
    expect(res.status).toBe(400);
  });

  it("verifies the user, logs them in, and burns the token on reuse", async () => {
    const userId = crypto.randomUUID();
    const email = `${crypto.randomUUID()}@example.com`;
    const now = Math.floor(Date.now() / 1000);
    const rawToken = "verify-" + crypto.randomUUID();

    await env.DB.prepare(
      `INSERT INTO users (id, email, password_hash, email_verified, created_at) VALUES (?, ?, ?, 0, ?)`
    )
      .bind(userId, email, "irrelevant-hash", now)
      .run();
    await env.DB.prepare(
      `INSERT INTO email_verifications (token, user_id, expires_at, used) VALUES (?, ?, ?, 0)`
    )
      .bind(await sha256Hex(rawToken), userId, now + 3600)
      .run();

    const res = await SELF.fetch(
      `https://railcast.test/auth/verify-email?token=${rawToken}`,
      { redirect: "manual" }
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard");
    expect(res.headers.get("Set-Cookie")).toContain("session=");

    const user = await env.DB.prepare(`SELECT email_verified FROM users WHERE id = ?`)
      .bind(userId)
      .first<{ email_verified: number }>();
    expect(user?.email_verified).toBe(1);

    const reuse = await SELF.fetch(
      `https://railcast.test/auth/verify-email?token=${rawToken}`,
      { redirect: "manual" }
    );
    expect(reuse.status).toBe(400);
  });
});

describe("POST /auth/login", () => {
  async function registerAndVerify(email: string, password: string): Promise<void> {
    await SELF.fetch("https://railcast.test/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    // Registration leaves the account unverified — flip it directly, same
    // effect as the person clicking the confirmation link.
    await env.DB.prepare(`UPDATE users SET email_verified = 1 WHERE email = ?`)
      .bind(email)
      .run();
  }

  it("401s on a wrong password", async () => {
    const email = `${crypto.randomUUID()}@example.com`;
    await registerAndVerify(email, "correct-horse-battery");

    const res = await SELF.fetch("https://railcast.test/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "wrong-password" }),
    });
    expect(res.status).toBe(401);
  });

  it("401s for an email with no password set (magic-link-only account)", async () => {
    const userId = crypto.randomUUID();
    const email = `${crypto.randomUUID()}@example.com`;
    await env.DB.prepare(
      `INSERT INTO users (id, email, email_verified, created_at) VALUES (?, ?, 1, ?)`
    )
      .bind(userId, email, Math.floor(Date.now() / 1000))
      .run();

    const res = await SELF.fetch("https://railcast.test/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "whatever" }),
    });
    expect(res.status).toBe(401);
  });

  it("403s with the correct password if the email hasn't been confirmed yet", async () => {
    const email = `${crypto.randomUUID()}@example.com`;
    await SELF.fetch("https://railcast.test/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "correct-horse-battery" }),
    });

    const res = await SELF.fetch("https://railcast.test/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "correct-horse-battery" }),
    });
    expect(res.status).toBe(403);
  });

  it("logs in with the correct password once verified, and returns a working session", async () => {
    const email = `${crypto.randomUUID()}@example.com`;
    await registerAndVerify(email, "correct-horse-battery");

    const login = await SELF.fetch("https://railcast.test/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "correct-horse-battery" }),
    });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get("Set-Cookie") ?? "";
    const sessionId = setCookie.match(/session=([^;]+)/)?.[1];
    expect(sessionId).toBeTruthy();

    const me = await SELF.fetch("https://railcast.test/api/me", {
      headers: { Cookie: `session=${sessionId}` },
    });
    expect(me.status).toBe(200);
    const body = await me.json<{ email: string }>();
    expect(body.email).toBe(email);
  });
});

describe("GET /api/me", () => {
  it("401s with no session cookie", async () => {
    const res = await SELF.fetch("https://railcast.test/api/me");
    expect(res.status).toBe(401);
  });

  it("401s with an expired session", async () => {
    const userId = crypto.randomUUID();
    const sessionId = "expired-session-" + crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);

    await env.DB.prepare(`INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)`)
      .bind(userId, `${crypto.randomUUID()}@example.com`, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`
    )
      .bind(await sha256Hex(sessionId), userId, now - 60, now - 3600)
      .run();

    const res = await SELF.fetch("https://railcast.test/api/me", {
      headers: { Cookie: `session=${sessionId}` },
    });
    expect(res.status).toBe(401);
  });

  it("returns the user for a valid session", async () => {
    const userId = crypto.randomUUID();
    const sessionId = "valid-session-" + crypto.randomUUID();
    const email = `${crypto.randomUUID()}@example.com`;
    const now = Math.floor(Date.now() / 1000);

    await env.DB.prepare(`INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)`)
      .bind(userId, email, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`
    )
      .bind(await sha256Hex(sessionId), userId, now + 3600, now)
      .run();

    const res = await SELF.fetch("https://railcast.test/api/me", {
      headers: { Cookie: `session=${sessionId}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ id: string; email: string }>();
    expect(body.email).toBe(email);
  });
});

describe("API tokens", () => {
  async function loggedInCookieAndUser(): Promise<{ cookie: string; userId: string }> {
    const userId = crypto.randomUUID();
    const sessionId = "session-" + crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(`INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)`)
      .bind(userId, `${crypto.randomUUID()}@example.com`, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`
    )
      .bind(await sha256Hex(sessionId), userId, now + 3600, now)
      .run();
    return { cookie: `session=${sessionId}`, userId };
  }

  it("returns an id alongside each token's preview", async () => {
    const { cookie } = await loggedInCookieAndUser();

    const create = await SELF.fetch("https://railcast.test/api/tokens", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(create.status).toBe(201);
    const created = await create.json<{ id: string; token: string }>();
    expect(created.id).toBeTruthy();

    const list = await SELF.fetch("https://railcast.test/api/tokens", {
      headers: { Cookie: cookie },
    });
    const body = await list.json<{ tokens: { id: string; preview: string }[] }>();
    expect(body.tokens).toHaveLength(1);
    expect(body.tokens[0].id).toBe(created.id);
    expect(body.tokens[0].preview).toContain(created.token.slice(0, 8));
  });

  it("revokes a token so it no longer authenticates", async () => {
    const { cookie } = await loggedInCookieAndUser();

    const create = await SELF.fetch("https://railcast.test/api/tokens", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    const { id, token } = await create.json<{ id: string; token: string }>();

    const del = await SELF.fetch(`https://railcast.test/api/tokens/${id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(del.status).toBe(204);

    const list = await SELF.fetch("https://railcast.test/api/tokens", {
      headers: { Cookie: cookie },
    });
    const body = await list.json<{ tokens: unknown[] }>();
    expect(body.tokens).toHaveLength(0);

    // and it no longer works as a bearer token for the CLI-facing API either
    const res = await SELF.fetch("https://railcast.test/api/apps", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "should-not-work", signing_public_key: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("404s revoking a token that belongs to someone else", async () => {
    const owner = await loggedInCookieAndUser();
    const attacker = await loggedInCookieAndUser();

    const create = await SELF.fetch("https://railcast.test/api/tokens", {
      method: "POST",
      headers: { Cookie: owner.cookie },
    });
    const { id } = await create.json<{ id: string }>();

    const del = await SELF.fetch(`https://railcast.test/api/tokens/${id}`, {
      method: "DELETE",
      headers: { Cookie: attacker.cookie },
    });
    expect(del.status).toBe(404);
  });
});

describe("POST /api/apps", () => {
  async function loggedInCookie(): Promise<string> {
    const userId = crypto.randomUUID();
    const sessionId = "session-" + crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(`INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)`)
      .bind(userId, `${crypto.randomUUID()}@example.com`, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`
    )
      .bind(await sha256Hex(sessionId), userId, now + 3600, now)
      .run();
    return `session=${sessionId}`;
  }

  it("rejects a missing name", async () => {
    const cookie = await loggedInCookie();
    const res = await SELF.fetch("https://railcast.test/api/apps", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ signing_public_key: "key" }),
    });
    expect(res.status).toBe(400);
  });

  it("generates a server-side id and ignores a client-supplied one", async () => {
    const cookie = await loggedInCookie();
    const res = await SELF.fetch("https://railcast.test/api/apps", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      // Even if something in the request tries to set an id directly, the
      // server must ignore it — the public id is never client-chosen.
      body: JSON.stringify({ id: "attacker-chosen-slug", name: "My App", signing_public_key: "pubkey" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ id: string; name: string }>();
    expect(body.id).toBeTruthy();
    expect(body.id).not.toBe("attacker-chosen-slug");
    expect(body.name).toBe("My App");
  });

  it("allows two apps with the same name — name is just a label, not a key", async () => {
    const cookie = await loggedInCookie();
    const create = () =>
      SELF.fetch("https://railcast.test/api/apps", {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "duplicate-name", signing_public_key: "pubkey" }),
      });

    const first = await create();
    expect(first.status).toBe(201);
    const firstBody = await first.json<{ id: string }>();

    const second = await create();
    expect(second.status).toBe(201);
    const secondBody = await second.json<{ id: string }>();

    // Different apps, different ids, same name — no collision anywhere.
    expect(secondBody.id).not.toBe(firstBody.id);
  });

  it("accepts a bearer API token in place of a session cookie", async () => {
    const userId = crypto.randomUUID();
    const token = "cli-token-" + crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(`INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)`)
      .bind(userId, `${crypto.randomUUID()}@example.com`, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO api_tokens (token, user_id, created_at, preview) VALUES (?, ?, ?, ?)`
    )
      .bind(await sha256Hex(token), userId, now, token.slice(0, 8))
      .run();

    const res = await SELF.fetch("https://railcast.test/api/apps", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "cli-created-app", signing_public_key: "pubkey" }),
    });
    expect(res.status).toBe(201);
  });
});
