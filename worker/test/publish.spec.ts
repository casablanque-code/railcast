import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "./setup";

async function seedUserAppAndToken(appId = "myapp-" + crypto.randomUUID()) {
  const userId = crypto.randomUUID();
  const token = "test-token-" + crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  await env.DB.prepare(`INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)`)
    .bind(userId, `${crypto.randomUUID()}@example.com`, now)
    .run();

  await env.DB.prepare(
    `INSERT INTO apps (id, owner_email, owner_user_id, signing_public_key, name, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(appId, `${crypto.randomUUID()}@example.com`, userId, "fake-public-key", "Test App", now)
    .run();

  await env.DB.prepare(`INSERT INTO api_tokens (token, user_id, created_at) VALUES (?, ?, ?)`)
    .bind(await sha256Hex(token), userId, now)
    .run();

  return { userId, token, appId };
}

describe("appcast.xml", () => {
  it("404s for an app with no published versions", async () => {
    const res = await SELF.fetch("https://railcast.test/unknown-app/appcast.xml");
    expect(res.status).toBe(404);
  });

  it("404s a beta channel request with no or wrong token", async () => {
    const { appId } = await seedUserAppAndToken();
    await env.DB.prepare(`UPDATE apps SET beta_token = ? WHERE id = ?`)
      .bind("correct-token", appId)
      .run();

    const noToken = await SELF.fetch(`https://railcast.test/${appId}/appcast.xml?channel=beta`);
    expect(noToken.status).toBe(404);

    const wrongToken = await SELF.fetch(
      `https://railcast.test/${appId}/appcast.xml?channel=beta&token=nope`
    );
    expect(wrongToken.status).toBe(404);
  });
});

describe("upload", () => {
  it("rejects requests without a bearer token", async () => {
    const res = await SELF.fetch("https://railcast.test/some-app/upload/build.zip", {
      method: "PUT",
      body: "bytes",
    });
    expect(res.status).toBe(401);
  });

  it("rejects a token that doesn't own the app", async () => {
    const { appId } = await seedUserAppAndToken();
    const res = await SELF.fetch(`https://railcast.test/${appId}/upload/build.zip`, {
      method: "PUT",
      headers: { Authorization: "Bearer someone-elses-token" },
      body: "bytes",
    });
    expect(res.status).toBe(401);
  });
});

describe("publish flow", () => {
  it("uploads a build, registers a version, then serves it in appcast.xml", async () => {
    const { token, appId } = await seedUserAppAndToken();

    const uploadRes = await SELF.fetch(`https://railcast.test/${appId}/upload/MyApp-1.0.0.zip`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
      body: "fake build bytes",
    });
    expect(uploadRes.status).toBe(200);
    const upload = await uploadRes.json<{ file_key: string; file_size: number }>();
    expect(upload.file_key).toBe(`${appId}/MyApp-1.0.0.zip`);
    expect(upload.file_size).toBeGreaterThan(0);

    const versionRes = await SELF.fetch(`https://railcast.test/${appId}/versions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: "1.0.0",
        build_number: 1,
        file_key: upload.file_key,
        file_size: upload.file_size,
        sha256: "deadbeef",
        signature: "fake-signature-b64",
        release_notes: "First release",
      }),
    });
    expect(versionRes.status).toBe(201);

    const appcastRes = await SELF.fetch(`https://railcast.test/${appId}/appcast.xml`);
    expect(appcastRes.status).toBe(200);
    const xml = await appcastRes.text();
    expect(xml).toContain("<sparkle:shortVersionString>1.0.0</sparkle:shortVersionString>");
    expect(xml).toContain('sparkle:edSignature="fake-signature-b64"');
  });

  it("rejects a version pointing at a file_key that was never uploaded", async () => {
    const { token, appId } = await seedUserAppAndToken();

    const res = await SELF.fetch(`https://railcast.test/${appId}/versions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: "1.0.0",
        build_number: 1,
        file_key: `${appId}/never-uploaded.zip`,
        file_size: 100,
        sha256: "deadbeef",
        signature: "sig",
      }),
    });
    expect(res.status).toBe(400);
  });
});
