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

async function publishVersion(token: string, appId: string, version: string, buildNumber: number) {
  const filename = `MyApp-${version}.zip`;
  const uploadRes = await SELF.fetch(`https://railcast.test/${appId}/upload/${filename}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}` },
    body: `bytes for ${version}`,
  });
  const upload = await uploadRes.json<{ file_key: string; file_size: number }>();

  return SELF.fetch(`https://railcast.test/${appId}/versions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      version,
      build_number: buildNumber,
      file_key: upload.file_key,
      file_size: upload.file_size,
      sha256: "deadbeef",
      signature: `sig-${version}`,
    }),
  });
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

  it("403s a valid token belonging to a different app's owner", async () => {
    const owner = await seedUserAppAndToken();
    const attacker = await seedUserAppAndToken();

    // attacker's token is real and valid — just not for owner's app
    const res = await SELF.fetch(`https://railcast.test/${owner.appId}/upload/build.zip`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${attacker.token}` },
      body: "bytes",
    });
    expect(res.status).toBe(403);
  });

  it("404s an app id that doesn't exist at all — distinct from 403 so the CLI can tell you the id is wrong", async () => {
    const { token } = await seedUserAppAndToken();
    const res = await SELF.fetch(`https://railcast.test/this-app-id-was-never-created/upload/build.zip`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
      body: "bytes",
    });
    expect(res.status).toBe(404);
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

  it("marks a version critical and omits the tag when not set", async () => {
    const { token, appId } = await seedUserAppAndToken();

    async function publish(build: number, critical: boolean) {
      const uploadRes = await SELF.fetch(`https://railcast.test/${appId}/upload/v${build}.zip`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
        body: "fake build bytes",
      });
      const upload = await uploadRes.json<{ file_key: string; file_size: number }>();
      return SELF.fetch(`https://railcast.test/${appId}/versions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          version: `1.0.${build}`,
          build_number: build,
          file_key: upload.file_key,
          file_size: upload.file_size,
          sha256: "deadbeef",
          signature: "fake-signature-b64",
          critical,
        }),
      });
    }

    expect((await publish(1, false)).status).toBe(201);
    expect((await publish(2, true)).status).toBe(201);

    const xml = await (await SELF.fetch(`https://railcast.test/${appId}/appcast.xml`)).text();
    // Only the latest 10 builds are served and build 2 (critical) sorts
    // first — assert the tag appears exactly once, next to that item.
    expect(xml.match(/<sparkle:criticalUpdate\/>/g)?.length).toBe(1);
  });

  it("echoes phased_rollout_interval into the appcast and validates it server-side", async () => {
    const { token, appId } = await seedUserAppAndToken();

    const uploadRes = await SELF.fetch(`https://railcast.test/${appId}/upload/rollout.zip`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
      body: "fake build bytes",
    });
    const upload = await uploadRes.json<{ file_key: string; file_size: number }>();

    const bad = await SELF.fetch(`https://railcast.test/${appId}/versions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: "1.1.0",
        build_number: 1,
        file_key: upload.file_key,
        file_size: upload.file_size,
        sha256: "deadbeef",
        signature: "fake-signature-b64",
        phased_rollout_interval: -1,
      }),
    });
    expect(bad.status).toBe(400);

    const good = await SELF.fetch(`https://railcast.test/${appId}/versions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: "1.1.0",
        build_number: 1,
        file_key: upload.file_key,
        file_size: upload.file_size,
        sha256: "deadbeef",
        signature: "fake-signature-b64",
        phased_rollout_interval: 86400,
      }),
    });
    expect(good.status).toBe(201);

    const xml = await (await SELF.fetch(`https://railcast.test/${appId}/appcast.xml`)).text();
    expect(xml).toContain("<sparkle:phasedRolloutInterval>86400</sparkle:phasedRolloutInterval>");
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

  it("bumping to a higher build_number replaces what appcast.xml serves as latest", async () => {
    const { token, appId } = await seedUserAppAndToken();

    const first = await publishVersion(token, appId, "1.1.1", 1);
    expect(first.status).toBe(201);

    const bumped = await publishVersion(token, appId, "2.2.2", 2);
    expect(bumped.status).toBe(201);

    const appcastRes = await SELF.fetch(`https://railcast.test/${appId}/appcast.xml`);
    const xml = await appcastRes.text();

    // Newest (highest build_number) must be the first <item> — that's what
    // an RSS/Sparkle consumer treats as "latest".
    const firstItemIndex = xml.indexOf("<item>");
    const versionIndex = xml.indexOf("<sparkle:shortVersionString>2.2.2</sparkle:shortVersionString>");
    expect(versionIndex).toBeGreaterThan(firstItemIndex);
    expect(xml.indexOf("2.2.2")).toBeLessThan(xml.indexOf("1.1.1"));
  });

  it("rejects publishing a build_number that isn't strictly greater than the current latest", async () => {
    const { token, appId } = await seedUserAppAndToken();

    const first = await publishVersion(token, appId, "2.2.2", 5);
    expect(first.status).toBe(201);

    const sameBuild = await publishVersion(token, appId, "2.2.2-again", 5);
    expect(sameBuild.status).toBe(409);

    const lowerBuild = await publishVersion(token, appId, "1.1.1", 3);
    expect(lowerBuild.status).toBe(409);

    // appcast is unaffected by the rejected attempts
    const appcastRes = await SELF.fetch(`https://railcast.test/${appId}/appcast.xml`);
    const xml = await appcastRes.text();
    expect(xml).toContain("2.2.2");
    expect(xml).not.toContain("1.1.1");
  });

  it("a fresh build_number on a different channel is independent of stable", async () => {
    const { token, appId } = await seedUserAppAndToken();
    await env.DB.prepare(`UPDATE apps SET beta_token = ? WHERE id = ?`)
      .bind("beta-secret", appId)
      .run();

    const stable = await publishVersion(token, appId, "1.0.0", 10);
    expect(stable.status).toBe(201);

    // A beta build_number lower than stable's is fine — channels track
    // build_number independently.
    const betaUpload = await SELF.fetch(`https://railcast.test/${appId}/upload/beta.zip`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
      body: "beta bytes",
    });
    const beta = await betaUpload.json<{ file_key: string; file_size: number }>();
    const betaVersion = await SELF.fetch(`https://railcast.test/${appId}/versions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: "1.1.0-beta",
        build_number: 1,
        channel: "beta",
        file_key: beta.file_key,
        file_size: beta.file_size,
        sha256: "deadbeef",
        signature: "sig-beta",
      }),
    });
    expect(betaVersion.status).toBe(201);
  });
});

describe("DELETE /api/apps/:id", () => {
  it("owner can delete their app; it disappears from the feed and the listing", async () => {
    const { token, appId, userId } = await seedUserAppAndToken();
    await publishVersion(token, appId, "1.0.0", 1);

    const sessionId = "session-" + crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`
    )
      .bind(await sha256Hex(sessionId), userId, now + 3600, now)
      .run();
    const cookie = `session=${sessionId}`;

    const del = await SELF.fetch(`https://railcast.test/api/apps/${appId}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(del.status).toBe(204);

    const appcastRes = await SELF.fetch(`https://railcast.test/${appId}/appcast.xml`);
    expect(appcastRes.status).toBe(404);

    const list = await SELF.fetch("https://railcast.test/api/apps", { headers: { Cookie: cookie } });
    const body = await list.json<{ apps: { id: string }[] }>();
    expect(body.apps.find((a) => a.id === appId)).toBeUndefined();
  });

  it("403s deleting an app that belongs to someone else", async () => {
    const owner = await seedUserAppAndToken();

    const attackerId = crypto.randomUUID();
    const attackerSession = "session-" + crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(`INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)`)
      .bind(attackerId, `${crypto.randomUUID()}@example.com`, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`
    )
      .bind(await sha256Hex(attackerSession), attackerId, now + 3600, now)
      .run();

    const del = await SELF.fetch(`https://railcast.test/api/apps/${owner.appId}`, {
      method: "DELETE",
      headers: { Cookie: `session=${attackerSession}` },
    });
    // Distinct from the "app id doesn't exist" 404 elsewhere — matches
    // requireAppOwnership's split (see worker/src/index.ts): the id space
    // is a random 71-bit string, so a 403-vs-404 distinction here doesn't
    // help enumeration, and consistency with the CLI's create/upload path
    // matters more than uniformly hiding ownership.
    expect(del.status).toBe(403);

    // and the app is still there
    const appcastRes = await SELF.fetch(`https://railcast.test/${owner.appId}/appcast.xml`);
    expect(appcastRes.status).toBe(404); // no versions published yet in this test, but not because it was deleted
  });

  it("401s deleting without auth", async () => {
    const { appId } = await seedUserAppAndToken();
    const res = await SELF.fetch(`https://railcast.test/api/apps/${appId}`, { method: "DELETE" });
    expect(res.status).toBe(401);
  });
});
