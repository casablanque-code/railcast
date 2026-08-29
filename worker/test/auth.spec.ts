import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

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
      .bind(sessionId, userId, now - 60, now - 3600)
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
      .bind(sessionId, userId, now + 3600, now)
      .run();

    const res = await SELF.fetch("https://railcast.test/api/me", {
      headers: { Cookie: `session=${sessionId}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ id: string; email: string }>();
    expect(body.email).toBe(email);
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
      .bind(sessionId, userId, now + 3600, now)
      .run();
    return `session=${sessionId}`;
  }

  it("rejects an invalid app id", async () => {
    const cookie = await loggedInCookie();
    const res = await SELF.fetch("https://railcast.test/api/apps", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "not a valid slug!", signing_public_key: "key" }),
    });
    expect(res.status).toBe(400);
  });

  it("creates an app and rejects a duplicate id", async () => {
    const cookie = await loggedInCookie();
    const create = () =>
      SELF.fetch("https://railcast.test/api/apps", {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ id: "unique-app", signing_public_key: "pubkey" }),
      });

    const first = await create();
    expect(first.status).toBe(201);

    const second = await create();
    expect(second.status).toBe(409);
  });
});
