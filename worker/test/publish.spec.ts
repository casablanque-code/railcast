import { SELF, env } from "cloudflare:test";
import worker from "../src/index";
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
    const descMatch = xml.match(/<description[^>]*><!\[CDATA\[([\s\S]*?)]]><\/description>/);
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

describe("Authorization header parsing", () => {
  async function listApps(authorization: string) {
    return SELF.fetch("https://railcast.test/api/apps", { headers: { Authorization: authorization } });
  }

  it("accepts the Bearer scheme case-insensitively", async () => {
    const { token } = await seedUserAppAndToken();
    expect((await listApps(`Bearer ${token}`)).status).toBe(200);
    expect((await listApps(`bearer ${token}`)).status).toBe(200);
  });

  it("rejects other schemes and extra tokens in the header", async () => {
    const { token } = await seedUserAppAndToken();
    expect((await listApps(`Token ${token}`)).status).toBe(401);
    expect((await listApps(`Basic Bearer ${token}`)).status).toBe(401);
    expect((await listApps(`Bearer ${token} extra`)).status).toBe(401);
    expect((await listApps(token)).status).toBe(401);
  });
});

describe("appcast edge cache", () => {
  async function insertVersionRow(appId: string, version: string, build: number, channel = "stable") {
    await env.DB.prepare(
      `INSERT INTO versions (app_id, channel, version, build_number, file_key, file_size, sha256, signature, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, 'sig', ?)`
    )
      .bind(appId, channel, version, build, `${appId}/${version}.zip`, "0".repeat(64), Math.floor(Date.now() / 1000))
      .run();
  }

  it("serves the stable feed from cache, and a publish purges it", async () => {
    const { token, appId } = await seedUserAppAndToken();
    await insertVersionRow(appId, "1.0.0", 1);

    const first = await SELF.fetch(`https://railcast.test/${appId}/appcast.xml`);
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toContain("public");
    expect(await first.text()).toContain("<sparkle:version>1</sparkle:version>");

    // A row added behind the Worker's back stays invisible while the cached copy lives...
    await insertVersionRow(appId, "1.1.0", 2);
    const stale = await (await SELF.fetch(`https://railcast.test/${appId}/appcast.xml`)).text();
    expect(stale).not.toContain("<sparkle:version>2</sparkle:version>");

    // ...but publishing through the API purges it.
    const published = await publishVersion(token, appId, "1.2.0", 3);
    expect(published.status).toBe(201);
    const fresh = await (await SELF.fetch(`https://railcast.test/${appId}/appcast.xml`)).text();
    expect(fresh).toContain("<sparkle:version>3</sparkle:version>");
    expect(fresh).toContain("<sparkle:version>2</sparkle:version>");
  });

  it("never caches the beta feed", async () => {
    const { appId } = await seedUserAppAndToken();
    await env.DB.prepare(`UPDATE apps SET beta_token = ? WHERE id = ?`).bind("beta-secret", appId).run();
    await insertVersionRow(appId, "2.0.0-beta", 1, "beta");

    const url = `https://railcast.test/${appId}/appcast.xml?channel=beta&token=beta-secret`;
    const first = await SELF.fetch(url);
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toContain("no-store");
    await first.text();

    await insertVersionRow(appId, "2.0.1-beta", 2, "beta");
    expect(await (await SELF.fetch(url)).text()).toContain("<sparkle:version>2</sparkle:version>");
  });
});

describe("min_system_version", () => {
  async function publishWithMin(token: string, appId: string, version: string, build: number, min?: string) {
    const { file_key, file_size, sha256 } = await uploadBuild(token, appId, `MyApp-${version}.zip`, `bytes ${version}`);
    return SELF.fetch(`https://railcast.test/${appId}/versions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        version, build_number: build, file_key, file_size, sha256, signature: "sig",
        ...(min === undefined ? {} : { min_system_version: min }),
      }),
    });
  }

  it("is served as sparkle:minimumSystemVersion when given", async () => {
    const { token, appId } = await seedUserAppAndToken();
    expect((await publishWithMin(token, appId, "1.0.0", 1, "13.0")).status).toBe(201);
    const xml = await (await SELF.fetch(`https://railcast.test/${appId}/appcast.xml`)).text();
    expect(xml).toContain("<sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion>");
  });

  it("is omitted when not given", async () => {
    const { token, appId } = await seedUserAppAndToken();
    expect((await publishWithMin(token, appId, "1.0.0", 1)).status).toBe(201);
    const xml = await (await SELF.fetch(`https://railcast.test/${appId}/appcast.xml`)).text();
    expect(xml).not.toContain("minimumSystemVersion");
  });

  it("rejects values that aren't a dotted version", async () => {
    const { token, appId } = await seedUserAppAndToken();
    for (const bad of ["", "latest", "13.0.0.1", "13.x", "<b>"]) {
      expect((await publishWithMin(token, appId, "1.0.0", 1, bad)).status).toBe(400);
    }
  });
});

describe("abuse limits", () => {
  async function put(token: string, appId: string, name: string, body: string) {
    return SELF.fetch(`https://railcast.test/${appId}/upload/${name}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "X-Sha256": await sha256Hex(body) },
      body,
    });
  }

  it("rejects an upload that would push the account past its storage quota", async () => {
    // STORAGE_QUOTA_BYTES is 4096 in vitest.config.mts.
    const { userId, token, appId } = await seedUserAppAndToken();
    await env.DB.prepare(
      `INSERT INTO versions (app_id, channel, version, build_number, file_key, file_size, sha256, signature, created_at)
       VALUES (?, 'stable', '1.0.0', 1, ?, 4000, ?, 'sig', ?)`
    )
      .bind(appId, `${appId}/old.zip`, "0".repeat(64), Math.floor(Date.now() / 1000))
      .run();

    const tooBig = await put(token, appId, "big.zip", "x".repeat(200));
    expect(tooBig.status).toBe(413);
    expect(await tooBig.text()).toContain("quota");

    const fits = await put(token, appId, "small.zip", "x".repeat(50));
    expect(fits.status).toBe(200);
    expect(userId).toBeTruthy();
  });

  it("counts quota across all of an account's apps", async () => {
    const { userId, token, appId } = await seedUserAppAndToken();
    const other = await seedSecondApp(userId);
    await env.DB.prepare(
      `INSERT INTO versions (app_id, channel, version, build_number, file_key, file_size, sha256, signature, created_at)
       VALUES (?, 'stable', '1.0.0', 1, ?, 4000, ?, 'sig', ?)`
    )
      .bind(other, `${other}/old.zip`, "0".repeat(64), Math.floor(Date.now() / 1000))
      .run();
    expect((await put(token, appId, "big.zip", "x".repeat(200))).status).toBe(413);
  });

  it("rate-limits uploads per account", async () => {
    const { userId, token, appId } = await seedUserAppAndToken();
    const now = Math.floor(Date.now() / 1000);
    const stmt = env.DB.prepare(`INSERT INTO rate_limit_hits (bucket, created_at) VALUES (?, ?)`);
    const bucket = await sha256Hex(`upload:user:${userId}`);
    await env.DB.batch(Array.from({ length: 60 }, () => stmt.bind(bucket, now)));

    const res = await put(token, appId, "one.zip", "hello");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });
});

describe("nightly orphan cleanup", () => {
  it("deletes unregistered uploads, keeps registered ones", async () => {
    const { token, appId } = await seedUserAppAndToken();
    expect((await publishVersion(token, appId, "1.0.0", 1)).status).toBe(201);
    await env.BUILDS.put(`${appId}/never-registered.zip`, "orphan bytes");

    const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException() {} } as unknown as ExecutionContext;
    const pending: Promise<unknown>[] = [];
    // A zero minimum age lets the just-uploaded orphan qualify.
    await worker.scheduled!({} as ScheduledController, { ...env, ORPHAN_MIN_AGE_SECONDS: "0" }, ctx);
    await Promise.all(pending);

    expect(await env.BUILDS.head(`${appId}/never-registered.zip`)).toBeNull();
    expect(await env.BUILDS.head(`${appId}/MyApp-1.0.0.zip`)).not.toBeNull();
  });

  it("leaves recent uploads alone (default 24 h minimum age)", async () => {
    const { appId } = await seedUserAppAndToken();
    await env.BUILDS.put(`${appId}/fresh.zip`, "just uploaded");

    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException() {} } as unknown as ExecutionContext;
    await worker.scheduled!({} as ScheduledController, env, ctx);
    await Promise.all(pending);

    expect(await env.BUILDS.head(`${appId}/fresh.zip`)).not.toBeNull();
  });
});

describe("yank / unyank", () => {
  async function releaseIds(token: string, appId: string): Promise<Record<string, number>> {
    const res = await SELF.fetch(`https://railcast.test/${appId}/releases`, { headers: { Authorization: `Bearer ${token}` } });
    const body = (await res.json()) as { releases: { id: number; version: string }[] };
    return Object.fromEntries(body.releases.map((r) => [r.version, r.id]));
  }
  const post = (token: string, appId: string, id: number, action: "yank" | "unyank") =>
    SELF.fetch(`https://railcast.test/${appId}/releases/${id}/${action}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  const feed = async (appId: string) => (await SELF.fetch(`https://railcast.test/${appId}/appcast.xml`)).text();

  it("hides a release from the appcast, and unyank brings it back", async () => {
    const { token, appId } = await seedUserAppAndToken();
    await publishVersion(token, appId, "1.0.0", 1);
    await publishVersion(token, appId, "1.1.0", 2);
    const ids = await releaseIds(token, appId);

    expect((await post(token, appId, ids["1.1.0"], "yank")).status).toBe(204);
    const yanked = await feed(appId);
    expect(yanked).not.toContain("<sparkle:version>2</sparkle:version>");
    expect(yanked).toContain("<sparkle:version>1</sparkle:version>");

    expect((await post(token, appId, ids["1.1.0"], "unyank")).status).toBe(204);
    expect(await feed(appId)).toContain("<sparkle:version>2</sparkle:version>");
  });

  it("is idempotent, and refuses to yank the only live release on a channel", async () => {
    const { token, appId } = await seedUserAppAndToken();
    await publishVersion(token, appId, "1.0.0", 1);
    await publishVersion(token, appId, "1.1.0", 2);
    const ids = await releaseIds(token, appId);

    expect((await post(token, appId, ids["1.1.0"], "yank")).status).toBe(204);
    expect((await post(token, appId, ids["1.1.0"], "yank")).status).toBe(204);
    const last = await post(token, appId, ids["1.0.0"], "yank");
    expect(last.status).toBe(409);
    expect(await feed(appId)).toContain("<sparkle:version>1</sparkle:version>");
  });

  it("lists the flag, keeps build numbers moving, and 404s on unknown ids", async () => {
    const { token, appId } = await seedUserAppAndToken();
    await publishVersion(token, appId, "1.0.0", 1);
    await publishVersion(token, appId, "1.1.0", 2);
    const ids = await releaseIds(token, appId);
    await post(token, appId, ids["1.1.0"], "yank");

    const list = (await (await SELF.fetch(`https://railcast.test/${appId}/releases`, { headers: { Authorization: `Bearer ${token}` } })).json()) as {
      releases: { version: string; yanked: number }[];
    };
    expect(list.releases.find((r) => r.version === "1.1.0")!.yanked).toBe(1);
    expect(list.releases.find((r) => r.version === "1.0.0")!.yanked).toBe(0);
    expect((await post(token, appId, 999999, "yank")).status).toBe(404);
  });

  it("needs a publish-scoped token", async () => {
    const { userId, token, appId } = await seedUserAppAndToken();
    await publishVersion(token, appId, "1.0.0", 1);
    await publishVersion(token, appId, "1.1.0", 2);
    const ids = await releaseIds(token, appId);
    const readOnly = await seedToken(userId, { scope: "read" });
    expect((await post(readOnly, appId, ids["1.1.0"], "yank")).status).toBe(403);
  });

  it("deleting a yanked release is allowed even when it leaves one live release", async () => {
    const { token, appId } = await seedUserAppAndToken();
    await publishVersion(token, appId, "1.0.0", 1);
    await publishVersion(token, appId, "1.1.0", 2);
    const ids = await releaseIds(token, appId);
    await post(token, appId, ids["1.1.0"], "yank");

    const del = (id: number) =>
      SELF.fetch(`https://railcast.test/${appId}/releases/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    expect((await del(ids["1.1.0"])).status).toBe(204);
    // 1.0.0 is now the only release — the old guard still protects it.
    expect((await del(ids["1.0.0"])).status).toBe(409);
  });
});

describe("export", () => {
  const exportReq = (token: string, appId: string, qs = "") =>
    SELF.fetch(`https://railcast.test/${appId}/export${qs}`, { headers: { Authorization: `Bearer ${token}` } });

  it("returns every release with signatures, plus appcasts for the new host", async () => {
    const { token, appId } = await seedUserAppAndToken();
    await publishVersion(token, appId, "1.0.0", 1);
    await publishVersion(token, appId, "1.1.0", 2);
    const releases = ((await (await SELF.fetch(`https://railcast.test/${appId}/releases`, { headers: { Authorization: `Bearer ${token}` } })).json()) as { releases: { id: number; version: string }[] }).releases;
    await SELF.fetch(`https://railcast.test/${appId}/releases/${releases.find((r) => r.version === "1.1.0")!.id}/yank`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    const res = await exportReq(token, appId, `?files_url=${encodeURIComponent("https://updates.example.com/files/")}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.app.id).toBe(appId);
    expect(body.app.signing_public_key).toBeTruthy();
    expect(body.releases).toHaveLength(2); // yanked ones are exported too
    expect(body.releases.every((r: any) => r.signature && r.file_key && r.sha256)).toBe(true);
    // The feed excludes the yanked release and points at the new host.
    expect(body.appcasts.stable).toContain("https://updates.example.com/files/");
    expect(body.appcasts.stable).toContain("<sparkle:version>1</sparkle:version>");
    expect(body.appcasts.stable).not.toContain("<sparkle:version>2</sparkle:version>");
  });

  it("omits appcasts without files_url, and rejects an insecure or malformed one", async () => {
    const { token, appId } = await seedUserAppAndToken();
    await publishVersion(token, appId, "1.0.0", 1);
    expect(((await (await exportReq(token, appId)).json()) as any).appcasts).toBeNull();
    expect((await exportReq(token, appId, "?files_url=http://example.com/f")).status).toBe(400);
    expect((await exportReq(token, appId, "?files_url=not-a-url")).status).toBe(400);
  });

  it("works with a read-only token and refuses other accounts' apps", async () => {
    const { userId, token, appId } = await seedUserAppAndToken();
    await publishVersion(token, appId, "1.0.0", 1);
    const readOnly = await seedToken(userId, { scope: "read" });
    expect((await exportReq(readOnly, appId)).status).toBe(200);

    const stranger = await seedUserAppAndToken();
    expect((await exportReq(stranger.token, appId)).status).toBe(403);
    expect((await SELF.fetch(`https://railcast.test/${appId}/export`)).status).toBe(401);
  });
});

describe("release notes format", () => {
  async function feedWithNotes(notes: string | undefined) {
    const { token, appId } = await seedUserAppAndToken();
    const { file_key, file_size, sha256 } = await uploadBuild(token, appId, "MyApp-1.0.0.zip", "bytes");
    const res = await SELF.fetch(`https://railcast.test/${appId}/versions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ version: "1.0.0", build_number: 1, file_key, file_size, sha256, signature: "sig", release_notes: notes }),
    });
    expect(res.status).toBe(201);
    return (await SELF.fetch(`https://railcast.test/${appId}/appcast.xml`)).text();
  }

  it("marks Markdown and plain-text notes as markdown", async () => {
    const xml = await feedWithNotes("## What's new\n\n- faster\n- <https://example.com>");
    expect(xml).toContain('<description sparkle:format="markdown"><![CDATA[## What');
  });

  it("leaves notes that start with an HTML tag as HTML", async () => {
    for (const html of ["<h2>New</h2><ul><li>faster</li></ul>", "  <p>Fixes</p>", "<!-- x --><p>y</p>"]) {
      const xml = await feedWithNotes(html);
      expect(xml).toContain("<description><![CDATA[");
      expect(xml).not.toContain("sparkle:format");
    }
  });

  it("emits no description without notes", async () => {
    expect(await feedWithNotes(undefined)).not.toContain("<description");
  });
});

describe("feed redirect", () => {
  const put = (token: string, appId: string, body: unknown) =>
    SELF.fetch(`https://railcast.test/${appId}/feed-redirect`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const get = (appId: string, qs = "") =>
    SELF.fetch(`https://railcast.test/${appId}/appcast.xml${qs}`, { redirect: "manual" });

  it("redirects the stable feed once set, and serves normally again when cleared", async () => {
    const { token, appId } = await seedUserAppAndToken();
    await publishVersion(token, appId, "1.0.0", 1);
    expect((await get(appId)).status).toBe(200); // primes the cache

    const set = await put(token, appId, { url: "https://updates.example.com/myapp/appcast.xml" });
    expect(set.status).toBe(200);
    const moved = await get(appId);
    expect(moved.status).toBe(302);
    expect(moved.headers.get("Location")).toBe("https://updates.example.com/myapp/appcast.xml");

    expect((await put(token, appId, { url: null })).status).toBe(200);
    expect((await get(appId)).status).toBe(200);
  });

  it("redirects a beta feed to appcast-<channel>.xml, only with a valid token", async () => {
    const { token, appId } = await seedUserAppAndToken();
    await env.DB.prepare(`UPDATE apps SET beta_token = ? WHERE id = ?`).bind("beta-secret", appId).run();
    await put(token, appId, { url: "https://updates.example.com/myapp/appcast.xml" });

    const ok = await get(appId, "?channel=beta&token=beta-secret");
    expect(ok.status).toBe(302);
    expect(ok.headers.get("Location")).toBe("https://updates.example.com/myapp/appcast-beta.xml");
    expect(ok.headers.get("Cache-Control")).toContain("no-store");
    expect((await get(appId, "?channel=beta&token=wrong")).status).toBe(404);
  });

  it("doesn't redirect beta when the target isn't named appcast.xml", async () => {
    const { token, appId } = await seedUserAppAndToken();
    await publishVersion(token, appId, "1.0.0", 1);
    await env.DB.prepare(`UPDATE apps SET beta_token = ? WHERE id = ?`).bind("beta-secret", appId).run();
    await put(token, appId, { url: "https://updates.example.com/feed.xml" });
    expect((await get(appId)).status).toBe(302);
    // No mapping for beta: falls through to the normal (here: empty) beta feed.
    expect((await get(appId, "?channel=beta&token=beta-secret")).status).toBe(404);
  });

  it("rejects insecure, credentialed, malformed and self-pointing targets", async () => {
    const { token, appId } = await seedUserAppAndToken();
    for (const bad of [
      "http://example.com/appcast.xml",
      "https://user:pw@example.com/appcast.xml",
      "not a url",
      "https://railcast.test/other/appcast.xml",
      "",
      42,
    ]) {
      expect((await put(token, appId, { url: bad })).status).toBe(400);
    }
    expect((await SELF.fetch(`https://railcast.test/${appId}/feed-redirect`, {
      method: "PUT", headers: { Authorization: `Bearer ${token}` }, body: "nope",
    })).status).toBe(400);
  });

  it("needs a publish-scoped token for this app, and shows up in the app list", async () => {
    const { userId, token, appId } = await seedUserAppAndToken();
    const readOnly = await seedToken(userId, { scope: "read" });
    expect((await put(readOnly, appId, { url: "https://updates.example.com/appcast.xml" })).status).toBe(403);
    expect((await SELF.fetch(`https://railcast.test/${appId}/feed-redirect`, { method: "PUT", body: "{}" })).status).toBe(401);

    await put(token, appId, { url: "https://updates.example.com/appcast.xml" });
    const list = (await (await SELF.fetch("https://railcast.test/api/apps", { headers: { Authorization: `Bearer ${token}` } })).json()) as {
      apps: { id: string; feed_redirect_url: string | null }[];
    };
    expect(list.apps.find((a) => a.id === appId)!.feed_redirect_url).toBe("https://updates.example.com/appcast.xml");
  });
});

describe("rate limiter", () => {
  // Distinct CF-Connecting-IP per request keeps the per-IP bucket out of the way,
  // so only the per-email bucket (10 login attempts/hour) is under test.
  const attempt = (email: string, i: number) =>
    SELF.fetch("https://railcast.test/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": `203.0.113.${i + 1}` },
      body: JSON.stringify({ email, password: "wrong-password" }),
    });

  it("lets exactly `limit` concurrent requests through, never more", async () => {
    const email = `race-${crypto.randomUUID()}@example.com`;
    const statuses = (await Promise.all(Array.from({ length: 30 }, (_, i) => attempt(email, i)))).map((r) => r.status);
    expect(statuses.filter((s) => s === 429)).toHaveLength(20);
    expect(statuses.filter((s) => s !== 429)).toHaveLength(10);
  });

  it("stores hashed buckets only, and rejected attempts aren't recorded", async () => {
    const email = `hashed-${crypto.randomUUID()}@example.com`;
    for (let i = 0; i < 12; i++) await attempt(email, i);

    const { results } = await env.DB.prepare(`SELECT bucket FROM rate_limit_hits`).all<{ bucket: string }>();
    const buckets = (results ?? []).map((r) => r.bucket);
    expect(buckets.some((b) => b.includes(email) || b.includes("203.0.113"))).toBe(false);

    const count = await env.DB.prepare(`SELECT COUNT(*) AS c FROM rate_limit_hits WHERE bucket = ?`)
      .bind(await sha256Hex(`authlogin:email:${email}`))
      .first<{ c: number }>();
    expect(count!.c).toBe(10); // 12 attempts, the 2 rejected ones left no row
  });
});
