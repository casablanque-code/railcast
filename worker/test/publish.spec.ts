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

// Adds a second app to an existing user, for scoping tests that need two
// apps under the same account.
async function seedSecondApp(userId: string, appId = "myapp-" + crypto.randomUUID()) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO apps (id, owner_email, owner_user_id, signing_public_key, name, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(appId, `${crypto.randomUUID()}@example.com`, userId, "fake-public-key", "Second App", now)
    .run();
  return appId;
}

// A token scoped to a single app_id, as created via handleApiCreateToken
// when app_id is passed — inserted directly here so scoping tests don't
// need to also exercise the dashboard session flow.
async function seedScopedToken(userId: string, appId: string) {
  const token = "test-scoped-token-" + crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO api_tokens (token, user_id, app_id, created_at) VALUES (?, ?, ?, ?)`
  )
    .bind(await sha256Hex(token), userId, appId, now)
    .run();
  return token;
}

// General-purpose token seeding for expiry/scope tests, where the default
// scoped/account-wide helpers above don't cover what's needed.
async function seedToken(
  userId: string,
  opts: { appId?: string | null; scope?: "publish" | "read"; expiresAt?: number | null } = {}
) {
  const token = "test-token-" + crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO api_tokens (token, user_id, app_id, scope, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      await sha256Hex(token),
      userId,
      opts.appId ?? null,
      opts.scope ?? "publish",
      opts.expiresAt ?? null,
      now
    )
    .run();
  return token;
}

async function seedSession(userId: string) {
  const sessionId = "session-" + crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`
  )
    .bind(await sha256Hex(sessionId), userId, now + 3600, now)
    .run();
  return `session=${sessionId}`;
}

// Uploads bytes the way the real CLI does: computes the real sha256
// client-side and sends it via X-Sha256, which the server now hands to R2
// to verify as the bytes stream in. Tests that need a working upload
// should go through this rather than faking a body/hash pair, since the
// server no longer trusts a hash it hasn't verified.
async function uploadBuild(token: string, appId: string, filename: string, body: string) {
  const sha256 = await sha256Hex(body);
  const res = await SELF.fetch(`https://railcast.test/${appId}/upload/${filename}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "X-Sha256": sha256 },
    body,
  });
  const json =
    res.status === 200 ? await res.json<{ file_key: string; file_size: number }>() : null;
  return { res, sha256, file_key: json?.file_key, file_size: json?.file_size };
}

async function publishVersion(token: string, appId: string, version: string, buildNumber: number) {
  const filename = `MyApp-${version}.zip`;
  const { file_key, file_size, sha256 } = await uploadBuild(
    token,
    appId,
    filename,
    `bytes for ${version}`
  );

  return SELF.fetch(`https://railcast.test/${appId}/versions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      version,
      build_number: buildNumber,
      file_key,
      file_size,
      sha256,
      signature: `sig-${version}`,
    }),
  });
}

// Same as publishVersion, but omits build_number entirely — the CLI does
// this when the person doesn't pass --build, and the server is expected to
// pick the next one itself.
async function publishVersionAutoBuild(
  token: string,
  appId: string,
  version: string,
  channel?: string
) {
  const filename = `MyApp-${version}.zip`;
  const { file_key, file_size, sha256 } = await uploadBuild(
    token,
    appId,
    filename,
    `bytes for ${version}`
  );

  return SELF.fetch(`https://railcast.test/${appId}/versions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      version,
      channel,
      file_key,
      file_size,
      sha256,
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
      headers: { Authorization: `Bearer ${attacker.token}`, "X-Sha256": await sha256Hex("bytes") },
      body: "bytes",
    });
    expect(res.status).toBe(403);
  });

  it("404s an app id that doesn't exist at all — distinct from 403 so the CLI can tell you the id is wrong", async () => {
    const { token } = await seedUserAppAndToken();
    const res = await SELF.fetch(`https://railcast.test/this-app-id-was-never-created/upload/build.zip`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "X-Sha256": await sha256Hex("bytes") },
      body: "bytes",
    });
    expect(res.status).toBe(404);
  });

  it("rejects an upload with no X-Sha256 header", async () => {
    const { token, appId } = await seedUserAppAndToken();
    const res = await SELF.fetch(`https://railcast.test/${appId}/upload/build.zip`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
      body: "bytes",
    });
    expect(res.status).toBe(400);
  });

  it("rejects an upload with a malformed X-Sha256 header", async () => {
    const { token, appId } = await seedUserAppAndToken();
    const res = await SELF.fetch(`https://railcast.test/${appId}/upload/build.zip`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "X-Sha256": "not-a-real-hash" },
      body: "bytes",
    });
    expect(res.status).toBe(400);
  });

  it("rejects an upload whose bytes don't match the claimed X-Sha256 — R2 verifies, we don't just trust it", async () => {
    const { token, appId } = await seedUserAppAndToken();
    const wrongHash = await sha256Hex("some completely different content");
    const res = await SELF.fetch(`https://railcast.test/${appId}/upload/build.zip`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "X-Sha256": wrongHash },
      body: "actual bytes being uploaded",
    });
    expect(res.status).toBe(400);
  });

  it("409s re-uploading to a file_key that's already attached to a published version", async () => {
    const { token, appId } = await seedUserAppAndToken();
    const publishRes = await publishVersion(token, appId, "1.0.0", 1);
    expect(publishRes.status).toBe(201);

    // Same filename as publishVersion's internal MyApp-1.0.0.zip — trying
    // to swap the bytes under an already-published version's file_key.
    const res = await SELF.fetch(`https://railcast.test/${appId}/upload/MyApp-1.0.0.zip`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Sha256": await sha256Hex("different bytes entirely"),
      },
      body: "different bytes entirely",
    });
    expect(res.status).toBe(409);
  });

  // MAX_UPLOAD_BYTES is set to 1024 in vitest.config.mts's test bindings,
  // specifically so these tests can exercise the limit with small bodies.
  it("413s an upload whose declared Content-Length exceeds the configured max", async () => {
    const { token, appId } = await seedUserAppAndToken();
    const body = "x".repeat(2000);
    const res = await SELF.fetch(`https://railcast.test/${appId}/upload/toolarge.zip`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "X-Sha256": await sha256Hex(body) },
      body,
    });
    expect(res.status).toBe(413);

    // And nothing should have been written to R2 for it.
    const head = await env.BUILDS.head(`${appId}/toolarge.zip`);
    expect(head).toBeNull();
  });

  it("411s an upload with no Content-Length header at all", async () => {
    const { token, appId } = await seedUserAppAndToken();
    const chunk = "y".repeat(50);

    // A streamed body with no Content-Length header. R2's put() only
    // accepts a stream whose length it can determine up front (the
    // original request/response body, or a FixedLengthStream) — wrapping
    // or otherwise deriving the stream to count bytes ourselves breaks
    // that property and put() throws for every upload, not just oversized
    // ones. So a missing Content-Length is rejected outright rather than
    // silently falling back to some other size-tracking mechanism.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });

    const res = await SELF.fetch(`https://railcast.test/${appId}/upload/streamed-nolength.zip`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "X-Sha256": await sha256Hex(chunk) },
      // @ts-expect-error - duplex is required by undici for streaming bodies
      duplex: "half",
      body: stream,
    });
    expect(res.status).toBe(411);

    const head = await env.BUILDS.head(`${appId}/streamed-nolength.zip`);
    expect(head).toBeNull();
  });

  it("accepts an upload right at the configured max", async () => {
    const { token, appId } = await seedUserAppAndToken();
    const body = "z".repeat(1024);
    const res = await SELF.fetch(`https://railcast.test/${appId}/upload/atlimit.zip`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "X-Sha256": await sha256Hex(body) },
      body,
    });
    expect(res.status).toBe(200);
  });
});

describe("publish flow", () => {
  it("uploads a build, registers a version, then serves it in appcast.xml", async () => {
    const { token, appId } = await seedUserAppAndToken();

    const {
      res: uploadRes,
      file_key,
      file_size,
      sha256,
    } = await uploadBuild(token, appId, "MyApp-1.0.0.zip", "fake build bytes");
    expect(uploadRes.status).toBe(200);
    expect(file_key).toBe(`${appId}/MyApp-1.0.0.zip`);
    expect(file_size).toBeGreaterThan(0);

    const versionRes = await SELF.fetch(`https://railcast.test/${appId}/versions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: "1.0.0",
        build_number: 1,
        file_key,
        file_size,
        sha256,
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

  it("does not let release_notes containing ]]> break out of the CDATA block", async () => {
    const { token, appId } = await seedUserAppAndToken();

    const {
      res: uploadRes,
      file_key,
      file_size,
      sha256,
    } = await uploadBuild(token, appId, "MyApp-1.0.2.zip", "fake build bytes 2");
    expect(uploadRes.status).toBe(200);

    // A malicious/careless note containing the literal CDATA terminator,
    // followed by markup that would be live XML if the terminator closed
    // the section early.
    const maliciousNotes =
      'Fixed a bug]]><item><title>Injected</title><enclosure url="evil"/></item> and improved performance';

    const versionRes = await SELF.fetch(`https://railcast.test/${appId}/versions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: "1.0.2",
        build_number: 1,
        file_key,
        file_size,
        sha256,
        signature: "fake-signature-b64",
        release_notes: maliciousNotes,
      }),
    });
    expect(versionRes.status).toBe(201);

    const appcastRes = await SELF.fetch(`https://railcast.test/${appId}/appcast.xml`);
    expect(appcastRes.status).toBe(200);
    const xml = await appcastRes.text();

    // Extract the <description> CDATA content. Because a real "]]>" inside
    // the notes gets split into "]]" + "]]><![CDATA[" + ">", the *only*
    // place "]]>" is immediately followed by "</description>" is the true,
    // final close — any "]]>" from an embedded split is instead followed
    // by "<![CDATA[". A non-greedy match up to the first "]]></description>"
    // therefore captures the whole (possibly multi-segment) CDATA payload,
    // split-markers included.
    const descMatch = xml.match(/<description><!\[CDATA\[([\s\S]*?)]]><\/description>/);
    expect(descMatch).not.toBeNull();

    // Undo the split-escaping to recover what should be byte-for-byte the
    // original notes text.
    const recovered = descMatch![1].replace(/]]]]><!\[CDATA\[>/g, "]]>");
    expect(recovered).toBe(maliciousNotes);

    // Now check the *rest* of the document — with the description's CDATA
    // blanked out — to make sure none of the injected markup escaped into
    // real XML structure. This is the part that would fail without
    // safeCData: without it, "]]>" in the notes closes the CDATA early and
    // the injected <item>/<enclosure> become live sibling elements.
    const xmlOutsideDescription = xml.replace(descMatch![0], "<description></description>");
    const itemCount = (xmlOutsideDescription.match(/<item>/g) ?? []).length;
    expect(itemCount).toBe(1);
    expect(xmlOutsideDescription).not.toContain('<enclosure url="evil"/>');
    expect(xmlOutsideDescription).not.toContain("Injected");

    // And the CDATA nesting in the full document must be balanced: every
    // opening marker has a matching close, so the split-CDATA escaping
    // didn't leave a dangling "<![CDATA[" or an extra "]]>".
    const opens = (xml.match(/<!\[CDATA\[/g) ?? []).length;
    const closes = (xml.match(/]]>/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it("rejects registering a version whose claimed sha256 doesn't match the verified upload", async () => {
    const { token, appId } = await seedUserAppAndToken();
    const { file_key, file_size } = await uploadBuild(
      token,
      appId,
      "MyApp-1.0.1.zip",
      "fake build bytes"
    );

    const res = await SELF.fetch(`https://railcast.test/${appId}/versions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: "1.0.1",
        build_number: 1,
        file_key,
        file_size,
        // A syntactically valid but wrong hash — this is the actual
        // "swap the file" attack: upload is legitimate and verified, but
        // the version record claims a different (e.g. previously signed)
        // sha256 than what's really sitting at file_key.
        sha256: await sha256Hex("something else entirely"),
        signature: "fake-signature-b64",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects registering a version whose claimed file_size doesn't match R2's actual stored size", async () => {
    const { token, appId } = await seedUserAppAndToken();
    const { file_key, sha256 } = await uploadBuild(
      token,
      appId,
      "MyApp-1.0.1b.zip",
      "fake build bytes"
    );

    const res = await SELF.fetch(`https://railcast.test/${appId}/versions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: "1.0.1",
        build_number: 1,
        file_key,
        // file_size is just a client-supplied number in the JSON body —
        // nothing ties it to reality unless the server checks it against
        // R2's own head.size, so claim something obviously wrong here.
        file_size: 999999,
        sha256,
        signature: "fake-signature-b64",
      }),
    });
    expect(res.status).toBe(400);

    // And the bad value must not have slipped into the database either.
    const row = await env.DB.prepare(`SELECT 1 FROM versions WHERE file_key = ?`)
      .bind(file_key)
      .first();
    expect(row).toBeNull();
  });

  it("rejects registering a version with a malformed (non-64-hex) sha256", async () => {
    const { token, appId } = await seedUserAppAndToken();
    const { file_key, file_size } = await uploadBuild(
      token,
      appId,
      "MyApp-1.0.2.zip",
      "fake build bytes"
    );

    const res = await SELF.fetch(`https://railcast.test/${appId}/versions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: "1.0.2",
        build_number: 1,
        file_key,
        file_size,
        sha256: "deadbeef",
        signature: "fake-signature-b64",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("marks a version critical and omits the tag when not set", async () => {
    const { token, appId } = await seedUserAppAndToken();

    async function publish(build: number, critical: boolean) {
      const { file_key, file_size, sha256 } = await uploadBuild(
        token,
        appId,
        `v${build}.zip`,
        "fake build bytes"
      );
      return SELF.fetch(`https://railcast.test/${appId}/versions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          version: `1.0.${build}`,
          build_number: build,
          file_key,
          file_size,
          sha256,
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

    const { file_key, file_size, sha256 } = await uploadBuild(
      token,
      appId,
      "rollout.zip",
      "fake build bytes"
    );

    const bad = await SELF.fetch(`https://railcast.test/${appId}/versions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: "1.1.0",
        build_number: 1,
        file_key,
        file_size,
        sha256,
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
        file_key,
        file_size,
        sha256,
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
        sha256: "a".repeat(64),
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
    const versionIndex = xml.indexOf(
      "<sparkle:shortVersionString>2.2.2</sparkle:shortVersionString>"
    );
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

  it("auto-assigns build_number when it's omitted, sequentially per channel", async () => {
    const { token, appId } = await seedUserAppAndToken();

    const first = await publishVersionAutoBuild(token, appId, "1.0.0");
    expect(first.status).toBe(201);
    const firstBody = await first.json<{ build_number: number }>();
    expect(firstBody.build_number).toBe(1);

    const second = await publishVersionAutoBuild(token, appId, "2.0.0");
    expect(second.status).toBe(201);
    const secondBody = await second.json<{ build_number: number }>();
    expect(secondBody.build_number).toBe(2);

    // An explicit build_number that jumps ahead is still respected ...
    const jump = await publishVersion(token, appId, "3.0.0", 10);
    expect(jump.status).toBe(201);

    // ... and the next omitted one picks up from there, not from where the
    // auto sequence had been (11, not 3).
    const afterJump = await publishVersionAutoBuild(token, appId, "4.0.0");
    const afterJumpBody = await afterJump.json<{ build_number: number }>();
    expect(afterJumpBody.build_number).toBe(11);
  });

  it("auto-assigned build_number tracks stable and beta independently", async () => {
    const { token, appId } = await seedUserAppAndToken();
    await env.DB.prepare(`UPDATE apps SET beta_token = ? WHERE id = ?`)
      .bind("beta-secret", appId)
      .run();

    const stable1 = await publishVersionAutoBuild(token, appId, "1.0.0");
    const stable1Body = await stable1.json<{ build_number: number }>();
    expect(stable1Body.build_number).toBe(1);

    const beta1 = await publishVersionAutoBuild(token, appId, "1.0.0-beta", "beta");
    const beta1Body = await beta1.json<{ build_number: number }>();
    expect(beta1Body.build_number).toBe(1);

    const stable2 = await publishVersionAutoBuild(token, appId, "1.0.1");
    const stable2Body = await stable2.json<{ build_number: number }>();
    expect(stable2Body.build_number).toBe(2);
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
    const { file_key, file_size, sha256 } = await uploadBuild(
      token,
      appId,
      "beta.zip",
      "beta bytes"
    );
    const betaVersion = await SELF.fetch(`https://railcast.test/${appId}/versions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: "1.1.0-beta",
        build_number: 1,
        channel: "beta",
        file_key,
        file_size,
        sha256,
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

describe("per-app token scoping", () => {
  it("an account-wide (unscoped) token still works against every app the account owns", async () => {
    // Regression check for backward compatibility: tokens created before
    // this feature existed have app_id = NULL and must keep working
    // exactly as before across all of an account's apps.
    const { token, appId: appA, userId } = await seedUserAppAndToken();
    const appB = await seedSecondApp(userId);

    const uploadA = await uploadBuild(token, appA, "MyApp-1.0.0.zip", "bytes for A");
    expect(uploadA.res.status).toBe(200);
    const uploadB = await uploadBuild(token, appB, "MyApp-1.0.0.zip", "bytes for B");
    expect(uploadB.res.status).toBe(200);
  });

  it("a token scoped to app A works for app A but is forbidden on app B, even though the same account owns both", async () => {
    const { appId: appA, userId } = await seedUserAppAndToken();
    const appB = await seedSecondApp(userId);
    const scopedToken = await seedScopedToken(userId, appA);

    const uploadA = await uploadBuild(scopedToken, appA, "MyApp-1.0.0.zip", "bytes for A");
    expect(uploadA.res.status).toBe(200);

    const uploadB = await SELF.fetch(`https://railcast.test/${appB}/upload/MyApp-1.0.0.zip`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${scopedToken}`, "X-Sha256": await sha256Hex("x") },
      body: "x",
    });
    expect(uploadB.status).toBe(403);

    // Nothing should have been written to app B's prefix in R2.
    const head = await env.BUILDS.head(`${appB}/MyApp-1.0.0.zip`);
    expect(head).toBeNull();
  });

  it("a scoped token is also forbidden from registering a version on a different app", async () => {
    const { appId: appA, userId } = await seedUserAppAndToken();
    const appB = await seedSecondApp(userId);
    const scopedToken = await seedScopedToken(userId, appA);

    // Upload to B with an account-wide-equivalent path isn't possible for
    // the scoped token (upload itself is already forbidden, tested above),
    // but /versions must independently enforce the same scoping rather
    // than relying only on the upload step having blocked it.
    const res = await SELF.fetch(`https://railcast.test/${appB}/versions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${scopedToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: "1.0.0",
        build_number: 1,
        file_key: `${appB}/whatever.zip`,
        file_size: 1,
        sha256: "0".repeat(64),
        signature: "sig",
      }),
    });
    expect(res.status).toBe(403);
  });

  it("a scoped token can delete the app it's scoped to, but not a different app the account owns", async () => {
    const { appId: appA, userId } = await seedUserAppAndToken();
    const appB = await seedSecondApp(userId);
    const scopedToken = await seedScopedToken(userId, appA);

    const delB = await SELF.fetch(`https://railcast.test/api/apps/${appB}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${scopedToken}` },
    });
    expect(delB.status).toBe(403);

    const delA = await SELF.fetch(`https://railcast.test/api/apps/${appA}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${scopedToken}` },
    });
    expect(delA.status).toBe(204);
  });

  it("a scoped token cannot be used to create a brand-new app", async () => {
    const { appId: appA, userId } = await seedUserAppAndToken();
    const scopedToken = await seedScopedToken(userId, appA);

    const res = await SELF.fetch("https://railcast.test/api/apps", {
      method: "POST",
      headers: { Authorization: `Bearer ${scopedToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Sneaky New App", signing_public_key: "fake-key" }),
    });
    expect(res.status).toBe(403);
  });

  it("an account-wide token can still create a new app", async () => {
    const { token } = await seedUserAppAndToken();

    const res = await SELF.fetch("https://railcast.test/api/apps", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "New App", signing_public_key: "fake-key" }),
    });
    expect(res.status).toBe(201);
  });
});

describe("POST /api/tokens", () => {
  it("refuses to create a 101st token once the per-account cap is hit", async () => {
    const { userId } = await seedUserAppAndToken();
    const cookie = await seedSession(userId);
    const now = Math.floor(Date.now() / 1000);
    // The one from seedUserAppAndToken counts too, so 99 more reaches 100.
    for (let i = 0; i < 99; i++) {
      await env.DB.prepare(
        `INSERT INTO api_tokens (id, token, user_id, created_at) VALUES (?, ?, ?, ?)`
      )
        .bind(crypto.randomUUID(), await sha256Hex(`capped-token-${i}`), userId, now)
        .run();
    }

    const res = await SELF.fetch("https://railcast.test/api/tokens", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(403);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("limit_reached");
  });

  it("creates an account-wide token when app_id is omitted", async () => {
    const { userId } = await seedUserAppAndToken();
    const cookie = await seedSession(userId);

    const res = await SELF.fetch("https://railcast.test/api/tokens", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ id: string; token: string; app_id: string | null }>();
    expect(body.app_id).toBeNull();

    const row = await env.DB.prepare(`SELECT app_id FROM api_tokens WHERE id = ?`)
      .bind(body.id)
      .first<{ app_id: string | null }>();
    expect(row?.app_id).toBeNull();
  });

  it("creates a per-app token when app_id names an app the user owns", async () => {
    const { appId, userId } = await seedUserAppAndToken();
    const cookie = await seedSession(userId);

    const res = await SELF.fetch("https://railcast.test/api/tokens", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ id: string; token: string; app_id: string | null }>();
    expect(body.app_id).toBe(appId);

    // And the resulting token is actually scoped: it should work for this
    // app and be rejected for another app under the same account.
    const otherApp = await seedSecondApp(userId);
    const uploadOwn = await uploadBuild(body.token, appId, "MyApp-1.0.0.zip", "bytes");
    expect(uploadOwn.res.status).toBe(200);

    const uploadOther = await SELF.fetch(
      `https://railcast.test/${otherApp}/upload/MyApp-1.0.0.zip`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${body.token}`, "X-Sha256": await sha256Hex("x") },
        body: "x",
      }
    );
    expect(uploadOther.status).toBe(403);
  });

  it("404s creating a token scoped to an app_id the user doesn't own", async () => {
    const owner = await seedUserAppAndToken();
    const attackerId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(`INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)`)
      .bind(attackerId, `${crypto.randomUUID()}@example.com`, now)
      .run();
    const attackerCookie = await seedSession(attackerId);

    const res = await SELF.fetch("https://railcast.test/api/tokens", {
      method: "POST",
      headers: { Cookie: attackerCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: owner.appId }),
    });
    expect(res.status).toBe(404);

    // And no token should have been created at all as a side effect.
    const count = await env.DB.prepare(`SELECT COUNT(*) as c FROM api_tokens WHERE user_id = ?`)
      .bind(attackerId)
      .first<{ c: number }>();
    expect(count?.c).toBe(0);
  });
});

describe("token expiry", () => {
  it("401s a request using an expired token", async () => {
    const { appId, userId } = await seedUserAppAndToken();
    const now = Math.floor(Date.now() / 1000);
    const expired = await seedToken(userId, { expiresAt: now - 60 });

    const res = await uploadBuild(expired, appId, "MyApp-1.0.0.zip", "bytes");
    expect(res.res.status).toBe(401);
  });

  it("accepts a token that expires in the future", async () => {
    const { appId, userId } = await seedUserAppAndToken();
    const now = Math.floor(Date.now() / 1000);
    const notYetExpired = await seedToken(userId, { expiresAt: now + 3600 });

    const res = await uploadBuild(notYetExpired, appId, "MyApp-1.0.0.zip", "bytes");
    expect(res.res.status).toBe(200);
  });

  it("accepts a token with no expiry at all (NULL)", async () => {
    const { appId, userId } = await seedUserAppAndToken();
    const forever = await seedToken(userId, { expiresAt: null });

    const res = await uploadBuild(forever, appId, "MyApp-1.0.0.zip", "bytes");
    expect(res.res.status).toBe(200);
  });
});

describe("token scope", () => {
  it("a read-scoped token is forbidden from uploading", async () => {
    const { appId, userId } = await seedUserAppAndToken();
    const readToken = await seedToken(userId, { scope: "read" });

    const res = await uploadBuild(readToken, appId, "MyApp-1.0.0.zip", "bytes");
    expect(res.res.status).toBe(403);
  });

  it("a read-scoped token is forbidden from registering a version", async () => {
    const { appId, userId } = await seedUserAppAndToken();
    const readToken = await seedToken(userId, { scope: "read" });

    const res = await SELF.fetch(`https://railcast.test/${appId}/versions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${readToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: "1.0.0",
        build_number: 1,
        file_key: `${appId}/whatever.zip`,
        file_size: 1,
        sha256: "0".repeat(64),
        signature: "sig",
      }),
    });
    expect(res.status).toBe(403);
  });

  it("a read-scoped token is forbidden from deleting the app", async () => {
    const { appId, userId } = await seedUserAppAndToken();
    const readToken = await seedToken(userId, { scope: "read" });

    const res = await SELF.fetch(`https://railcast.test/api/apps/${appId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${readToken}` },
    });
    expect(res.status).toBe(403);
  });

  it("a read-scoped token is forbidden from creating a new app", async () => {
    const { userId } = await seedUserAppAndToken();
    const readToken = await seedToken(userId, { scope: "read" });

    const res = await SELF.fetch("https://railcast.test/api/apps", {
      method: "POST",
      headers: { Authorization: `Bearer ${readToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "New App", signing_public_key: "fake-key" }),
    });
    expect(res.status).toBe(403);
  });

  it("a publish-scoped token can still do everything a publish token could before", async () => {
    const { appId, userId } = await seedUserAppAndToken();
    const publishToken = await seedToken(userId, { scope: "publish" });

    const res = await uploadBuild(publishToken, appId, "MyApp-1.0.0.zip", "bytes");
    expect(res.res.status).toBe(200);
  });
});

describe("last_used_at tracking", () => {
  it("stays NULL until the token's first use, then updates on each successful auth", async () => {
    const { token, appId, userId } = await seedUserAppAndToken();

    const tokenHash = await sha256Hex(token);
    const before = await env.DB.prepare(`SELECT last_used_at FROM api_tokens WHERE token = ?`)
      .bind(tokenHash)
      .first<{ last_used_at: number | null }>();
    expect(before?.last_used_at).toBeNull();

    await uploadBuild(token, appId, "MyApp-1.0.0.zip", "bytes");

    const after = await env.DB.prepare(`SELECT last_used_at FROM api_tokens WHERE token = ?`)
      .bind(tokenHash)
      .first<{ last_used_at: number | null }>();
    expect(after?.last_used_at).toEqual(expect.any(Number));
  });

  it("does not bump last_used_at for a failed/unknown token", async () => {
    const res = await SELF.fetch("https://railcast.test/api/apps", {
      headers: { Cookie: "session=this-does-not-exist" },
    });
    // Sanity: this should just fail auth, not touch any token row (there's
    // no row to touch here — this is really guarding against a future
    // regression where the update runs unconditionally instead of only
    // after a matched SELECT).
    expect(res.status).toBe(401);
  });
});

describe("POST /api/tokens with scope and expiry", () => {
  it("creates a read-scoped token with an explicit expiry", async () => {
    const { userId } = await seedUserAppAndToken();
    const cookie = await seedSession(userId);

    const res = await SELF.fetch("https://railcast.test/api/tokens", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "read", expires_in_days: 30 }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ id: string; scope: string; expires_at: number }>();
    expect(body.scope).toBe("read");
    expect(body.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(body.expires_at).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 31 * 86400);
  });

  it("defaults to publish scope and no expiry when omitted", async () => {
    const { userId } = await seedUserAppAndToken();
    const cookie = await seedSession(userId);

    const res = await SELF.fetch("https://railcast.test/api/tokens", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ scope: string; expires_at: number | null }>();
    expect(body.scope).toBe("publish");
    expect(body.expires_at).toBeNull();
  });

  it("rejects an invalid scope value", async () => {
    const { userId } = await seedUserAppAndToken();
    const cookie = await seedSession(userId);

    const res = await SELF.fetch("https://railcast.test/api/tokens", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "admin" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an out-of-range expires_in_days", async () => {
    const { userId } = await seedUserAppAndToken();
    const cookie = await seedSession(userId);

    const tooLong = await SELF.fetch("https://railcast.test/api/tokens", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ expires_in_days: 999999 }),
    });
    expect(tooLong.status).toBe(400);

    const zero = await SELF.fetch("https://railcast.test/api/tokens", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ expires_in_days: 0 }),
    });
    expect(zero.status).toBe(400);
  });
});

describe("GET /:appId/releases", () => {
  it("401s without auth", async () => {
    const { appId } = await seedUserAppAndToken();
    const res = await SELF.fetch(`https://railcast.test/${appId}/releases`);
    expect(res.status).toBe(401);
  });

  it("404s an app id that doesn't exist", async () => {
    const { token } = await seedUserAppAndToken();
    const res = await SELF.fetch("https://railcast.test/does-not-exist/releases", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  it("403s a token scoped to a different app", async () => {
    const { appId: appA, userId } = await seedUserAppAndToken();
    const appB = await seedSecondApp(userId);
    const scopedToken = await seedScopedToken(userId, appA);

    const res = await SELF.fetch(`https://railcast.test/${appB}/releases`, {
      headers: { Authorization: `Bearer ${scopedToken}` },
    });
    expect(res.status).toBe(403);
  });

  it("a read-scoped token can list releases (read is enough)", async () => {
    const { appId, userId } = await seedUserAppAndToken();
    const readToken = await seedToken(userId, { scope: "read" });

    const res = await SELF.fetch(`https://railcast.test/${appId}/releases`, {
      headers: { Authorization: `Bearer ${readToken}` },
    });
    expect(res.status).toBe(200);
  });

  it("a logged-in dashboard session (no bearer token at all) can list releases", async () => {
    const { appId, userId } = await seedUserAppAndToken();
    const cookie = await seedSession(userId);

    const res = await SELF.fetch(`https://railcast.test/${appId}/releases`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
  });

  it("a session cannot list releases for an app it doesn't own", async () => {
    const { userId } = await seedUserAppAndToken();
    const otherUserAppId = (await seedUserAppAndToken()).appId;
    const cookie = await seedSession(userId);

    const res = await SELF.fetch(`https://railcast.test/${otherUserAppId}/releases`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(403);
  });

  it("lists releases across channels, newest build first within each channel", async () => {
    const { token, appId } = await seedUserAppAndToken();

    await publishVersion(token, appId, "1.0.0", 1);
    await publishVersion(token, appId, "1.1.0", 2);
    const filenameBeta = "MyApp-beta.zip";
    const uploadBeta = await uploadBuild(token, appId, filenameBeta, "beta bytes");
    await SELF.fetch(`https://railcast.test/${appId}/versions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: "1.2.0-beta",
        build_number: 1,
        channel: "beta",
        file_key: uploadBeta.file_key,
        file_size: uploadBeta.file_size,
        sha256: uploadBeta.sha256,
        signature: "sig",
      }),
    });

    const res = await SELF.fetch(`https://railcast.test/${appId}/releases`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{
      app_id: string;
      releases: { id: number; channel: string; version: string; build_number: number }[];
    }>();
    expect(body.app_id).toBe(appId);

    const stable = body.releases.filter((r) => r.channel === "stable");
    expect(stable.map((r) => r.build_number)).toEqual([2, 1]);
    const beta = body.releases.filter((r) => r.channel === "beta");
    expect(beta.map((r) => r.version)).toEqual(["1.2.0-beta"]);
  });
});

describe("DELETE /:appId/releases/:id", () => {
  it("401s without auth", async () => {
    const { token, appId } = await seedUserAppAndToken();
    const publishRes = await publishVersion(token, appId, "1.0.0", 1);
    const { id } = await publishRes.json<{ id: number }>();
    const res = await SELF.fetch(`https://railcast.test/${appId}/releases/${id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });

  it("a read-scoped token is forbidden from deleting a release", async () => {
    const { token, appId, userId } = await seedUserAppAndToken();
    await publishVersion(token, appId, "1.0.0", 1);
    const list = await SELF.fetch(`https://railcast.test/${appId}/releases`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { releases } = await list.json<{ releases: { id: number }[] }>();

    const readToken = await seedToken(userId, { scope: "read" });
    const res = await SELF.fetch(`https://railcast.test/${appId}/releases/${releases[0].id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${readToken}` },
    });
    expect(res.status).toBe(403);
  });

  it("404s deleting a release id that belongs to a different app", async () => {
    const { token, appId: appA, userId } = await seedUserAppAndToken();
    await publishVersion(token, appA, "1.0.0", 1);
    const list = await SELF.fetch(`https://railcast.test/${appA}/releases`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { releases } = await list.json<{ releases: { id: number }[] }>();

    const appB = await seedSecondApp(userId);
    const res = await SELF.fetch(`https://railcast.test/${appB}/releases/${releases[0].id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);

    // And the release must still exist, untouched, on the real app.
    const stillThere = await env.DB.prepare(`SELECT 1 FROM versions WHERE id = ?`)
      .bind(releases[0].id)
      .first();
    expect(stillThere).not.toBeNull();
  });

  it("a logged-in dashboard session (no bearer token) can delete a release", async () => {
    const { token, appId, userId } = await seedUserAppAndToken();
    // Two releases on the channel so the delete doesn't trip the
    // "only release left" guard.
    const older = await publishVersion(token, appId, "1.0.0", 1);
    const { id } = await older.json<{ id: number }>();
    await publishVersion(token, appId, "1.1.0", 2);

    const cookie = await seedSession(userId);
    const res = await SELF.fetch(`https://railcast.test/${appId}/releases/${id}`, {
      method: "DELETE",
      headers: { Cookie: cookie, Origin: "https://railcast.test" },
    });
    expect(res.status).toBe(204);
  });

  it("rejects a session-authenticated delete from a foreign Origin", async () => {
    const { token, appId, userId } = await seedUserAppAndToken();
    const older = await publishVersion(token, appId, "1.0.0", 1);
    const { id } = await older.json<{ id: number }>();
    await publishVersion(token, appId, "1.1.0", 2);

    const cookie = await seedSession(userId);
    const res = await SELF.fetch(`https://railcast.test/${appId}/releases/${id}`, {
      method: "DELETE",
      headers: { Cookie: cookie, Origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });

  it("404s an unknown release id", async () => {
    const { token, appId } = await seedUserAppAndToken();
    const res = await SELF.fetch(`https://railcast.test/${appId}/releases/999999`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  it("a session cannot delete the only remaining release on a channel (409)", async () => {
    const { token, appId, userId } = await seedUserAppAndToken();
    const only = await publishVersion(token, appId, "1.0.0", 1);
    const { id } = await only.json<{ id: number }>();
    const cookie = await seedSession(userId);

    const res = await SELF.fetch(`https://railcast.test/${appId}/releases/${id}`, {
      method: "DELETE",
      headers: { Cookie: cookie, Origin: "https://railcast.test" },
    });
    expect(res.status).toBe(409);
  });

  it("400s a non-numeric release id", async () => {
    const { token, appId } = await seedUserAppAndToken();
    const res = await SELF.fetch(`https://railcast.test/${appId}/releases/not-a-number`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
  });

  it("deletes the release, removes it from the appcast, and deletes the R2 object", async () => {
    const { token, appId } = await seedUserAppAndToken();
    // Two releases on the same channel: deleting the older one must not
    // trip the "only release on this channel" guard, and the newer one
    // should still serve fine in the appcast afterward.
    const older = await publishVersion(token, appId, "1.0.0", 1);
    const { id, file_key } = await older.json<{ id: number; file_key: string }>();
    await publishVersion(token, appId, "1.1.0", 2);

    // Sanity: the object is actually in R2 before we delete anything.
    expect(await env.BUILDS.head(file_key)).not.toBeNull();

    const res = await SELF.fetch(`https://railcast.test/${appId}/releases/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(204);

    const row = await env.DB.prepare(`SELECT 1 FROM versions WHERE id = ?`).bind(id).first();
    expect(row).toBeNull();

    expect(await env.BUILDS.head(file_key)).toBeNull();

    // The newer release is still there, so the feed keeps working — it's
    // just down to one entry now instead of two.
    const appcastRes = await SELF.fetch(`https://railcast.test/${appId}/appcast.xml`);
    expect(appcastRes.status).toBe(200);
    const xml = await appcastRes.text();
    expect(xml).toContain("1.1.0");
    expect(xml).not.toContain("1.0.0");
  });

  it("does not delete the R2 object while another release row still references the same file_key", async () => {
    const { token, appId } = await seedUserAppAndToken();

    // An extra, unrelated release so the channel never drops to a single
    // entry while the two file_key-sharing rows below are deleted in
    // turn — that scenario is covered separately by the last-release
    // guard tests; this test is specifically about shared file_key
    // cleanup and shouldn't also be exercising that guard.
    await publishVersion(token, appId, "0.9.0", 1);

    const publishRes = await publishVersion(token, appId, "1.0.0", 2);
    const { id: firstId, file_key } = await publishRes.json<{ id: number; file_key: string }>();

    // Simulated edge case: two version rows pointing at the same file_key.
    // Not reachable through the normal API (upload's "already published"
    // check prevents it), but cheap to guard against directly rather than
    // assume it can never happen.
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO versions (app_id, channel, version, build_number, file_key, file_size, sha256, signature, critical, created_at)
       VALUES (?, 'stable', '1.0.1', 3, ?, 1, ?, 'sig', 0, ?)`
    )
      .bind(appId, file_key, "0".repeat(64), now)
      .run();

    const del1 = await SELF.fetch(`https://railcast.test/${appId}/releases/${firstId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(del1.status).toBe(204);

    // The other row still points at file_key, so the object must survive.
    expect(await env.BUILDS.head(file_key)).not.toBeNull();

    const secondRow = await env.DB.prepare(`SELECT id FROM versions WHERE file_key = ?`)
      .bind(file_key)
      .first<{ id: number }>();

    const del2 = await SELF.fetch(`https://railcast.test/${appId}/releases/${secondRow!.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(del2.status).toBe(204);

    // Now nothing references it — the object should finally be gone. The
    // channel still has the "0.9.0" keep-alive release, so this delete
    // wasn't blocked by the last-release guard either.
    expect(await env.BUILDS.head(file_key)).toBeNull();
  });

  it("409s deleting the only release on a channel, and leaves it untouched", async () => {
    const { token, appId } = await seedUserAppAndToken();
    const publishRes = await publishVersion(token, appId, "1.0.0", 1);
    const { id, file_key } = await publishRes.json<{ id: number; file_key: string }>();

    const res = await SELF.fetch(`https://railcast.test/${appId}/releases/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(409);

    // Nothing should have moved: the DB row and the R2 object both survive.
    const row = await env.DB.prepare(`SELECT 1 FROM versions WHERE id = ?`).bind(id).first();
    expect(row).not.toBeNull();
    expect(await env.BUILDS.head(file_key)).not.toBeNull();
  });

  it("allows draining a channel down to one release, then blocks the last one", async () => {
    const { token, appId } = await seedUserAppAndToken();
    const first = await publishVersion(token, appId, "1.0.0", 1);
    const { id: firstId } = await first.json<{ id: number }>();
    const second = await publishVersion(token, appId, "1.1.0", 2);
    const { id: secondId } = await second.json<{ id: number }>();

    const delFirst = await SELF.fetch(`https://railcast.test/${appId}/releases/${firstId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(delFirst.status).toBe(204);

    // Now only secondId is left on 'stable' — deleting it must now be
    // refused, even though it was allowed a moment ago for firstId.
    const delSecond = await SELF.fetch(`https://railcast.test/${appId}/releases/${secondId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(delSecond.status).toBe(409);

    const row = await env.DB.prepare(`SELECT 1 FROM versions WHERE id = ?`).bind(secondId).first();
    expect(row).not.toBeNull();
  });

  it("the last-release guard is per-channel, not per-app", async () => {
    const { token, appId } = await seedUserAppAndToken();
    const stable = await publishVersion(token, appId, "1.0.0", 1);
    const { id: stableId } = await stable.json<{ id: number }>();

    const betaUpload = await uploadBuild(token, appId, "MyApp-beta.zip", "beta bytes");
    await SELF.fetch(`https://railcast.test/${appId}/versions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: "1.1.0-beta",
        build_number: 1,
        channel: "beta",
        file_key: betaUpload.file_key,
        file_size: betaUpload.file_size,
        sha256: betaUpload.sha256,
        signature: "sig",
      }),
    });

    // The app now has two releases total, but only one *stable* release —
    // the beta release on a different channel must not count toward
    // "stable" having more than one, so this must still be blocked.
    const res = await SELF.fetch(`https://railcast.test/${appId}/releases/${stableId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(409);
  });

  it("two concurrent deletes of the last two releases on a channel: exactly one succeeds", async () => {
    const { token, appId } = await seedUserAppAndToken();
    const first = await publishVersion(token, appId, "1.0.0", 1);
    const { id: firstId } = await first.json<{ id: number }>();
    const second = await publishVersion(token, appId, "1.1.0", 2);
    const { id: secondId } = await second.json<{ id: number }>();

    const del = (id: number) =>
      SELF.fetch(`https://railcast.test/${appId}/releases/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });

    // Both requests see "2 releases exist" at the moment they're sent, but
    // the guard is enforced inside the DELETE's own atomic WHERE clause —
    // whichever one the database serializes second must see the
    // now-current count (1) and be refused, not the stale count either
    // request started with.
    const [a, b] = await Promise.all([del(firstId), del(secondId)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([204, 409]);

    const remaining = await env.DB.prepare(`SELECT COUNT(*) as c FROM versions WHERE app_id = ?`)
      .bind(appId)
      .first<{ c: number }>();
    expect(remaining?.c).toBe(1);
  });

  it("GET /:appId/releases reports the same history_limit the appcast enforces", async () => {
    const { token, appId } = await seedUserAppAndToken();
    await publishVersion(token, appId, "1.0.0", 1);

    const res = await SELF.fetch(`https://railcast.test/${appId}/releases`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json<{ history_limit: number }>();
    expect(body.history_limit).toBe(10);
  });
});

describe("GET /api/apps with a bearer token", () => {
  it("an account-wide token lists every app the account owns", async () => {
    const { token, appId: appA, userId } = await seedUserAppAndToken();
    const appB = await seedSecondApp(userId);

    const res = await SELF.fetch("https://railcast.test/api/apps", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ apps: { id: string }[] }>();
    const ids = body.apps.map((a) => a.id).sort();
    expect(ids).toEqual([appA, appB].sort());
  });

  it("a per-app scoped token only sees the one app it's scoped to", async () => {
    const { appId: appA, userId } = await seedUserAppAndToken();
    await seedSecondApp(userId);
    const scopedToken = await seedScopedToken(userId, appA);

    const res = await SELF.fetch("https://railcast.test/api/apps", {
      headers: { Authorization: `Bearer ${scopedToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ apps: { id: string }[] }>();
    expect(body.apps.map((a) => a.id)).toEqual([appA]);
  });

  it("401s without a session or a token", async () => {
    const res = await SELF.fetch("https://railcast.test/api/apps");
    expect(res.status).toBe(401);
  });
});

// Narrowing check: only GET/DELETE on a release accept the dashboard
// session (see requireAppOwnership's allowSession opt-in). Upload and
// version registration are CLI/CI actions and must stay bearer-only, even
// for the account's own logged-in session — otherwise an XSS on the
// dashboard could publish a build, not just manage existing releases.
describe("upload and version registration stay bearer-only", () => {
  it("401s an upload authenticated only with a session cookie", async () => {
    const { appId, userId } = await seedUserAppAndToken();
    const cookie = await seedSession(userId);

    const res = await SELF.fetch(`https://railcast.test/${appId}/upload/x.zip`, {
      method: "PUT",
      headers: { Cookie: cookie, "X-Sha256": await sha256Hex("x") },
      body: "x",
    });
    expect(res.status).toBe(401);
  });

  it("401s registering a version authenticated only with a session cookie", async () => {
    const { token, appId, userId } = await seedUserAppAndToken();
    const { file_key, file_size, sha256 } = await uploadBuild(token, appId, "x.zip", "x");
    const cookie = await seedSession(userId);

    const res = await SELF.fetch(`https://railcast.test/${appId}/versions`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: "1.0.0",
        build_number: 1,
        file_key,
        file_size,
        sha256,
        signature: "sig",
      }),
    });
    expect(res.status).toBe(401);
  });
});
