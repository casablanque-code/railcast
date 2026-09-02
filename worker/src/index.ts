export interface Env {
  DB: D1Database;
  BUILDS: R2Bucket;
  PUBLIC_FILE_BASE_URL: string;
  RESEND_API_KEY: string;
}

interface VersionRow {
  version: string;
  build_number: number;
  file_key: string;
  file_size: number;
  sha256: string;
  signature: string;
  release_notes: string | null;
  created_at: number;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatRfc2822(unixSeconds: number): string {
  // Date#toUTCString() ends in "GMT", which validators reject — RFC 2822
  // wants a numeric zone offset.
  return new Date(unixSeconds * 1000).toUTCString().replace("GMT", "+0000");
}

function renderAppcast(
  appId: string,
  rows: VersionRow[],
  fileBaseUrl: string,
  channelLink: string
): string {
  const items = rows
    .map((r) => {
      const pubDate = formatRfc2822(r.created_at);
      const downloadUrl = `${fileBaseUrl}/${r.file_key}`;
      const description = r.release_notes
        ? `\n      <description><![CDATA[${r.release_notes}]]></description>`
        : "";
      return `    <item>
      <title>Version ${escapeXml(r.version)}</title>
      <pubDate>${pubDate}</pubDate>
      <sparkle:version>${r.build_number}</sparkle:version>
      <sparkle:shortVersionString>${escapeXml(r.version)}</sparkle:shortVersionString>${description}
      <enclosure
        url="${escapeXml(downloadUrl)}"
        length="${r.file_size}"
        type="application/octet-stream"
        sparkle:edSignature="${escapeXml(r.signature)}"
      />
    </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>${escapeXml(appId)} Updates</title>
    <link>${escapeXml(channelLink)}</link>
${items}
  </channel>
</rss>`;
}

// ---------- Crypto / id helpers ----------

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Server-generated, opaque, unguessable app id. This is what shows up in
// the public appcast URL — it must NEVER be something the client gets to
// choose, or we're back to name-squatting + brute-forceable slugs.
// ~71 bits of entropy (12 chars, base62) — plenty for a URL path segment
// that's also checked for DB collision before use.
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
// 256 isn't divisible by 62, so `byte % 62` would favor the low 8 symbols
// slightly. Rejection sampling keeps every symbol equally likely instead —
// draw bytes 248..255 are the biased tail (256 - 256%62 = 248) and get
// discarded and redrawn.
const BASE62_REJECT_ABOVE = 256 - (256 % BASE62.length); // 248
function randomAppId(): string {
  const out: string[] = [];
  const buf = new Uint8Array(16);
  while (out.length < 12) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b >= BASE62_REJECT_ABOVE) continue;
      out.push(BASE62[b % BASE62.length]);
      if (out.length === 12) break;
    }
  }
  return out.join("");
}

// Constant-time string compare. Used for beta_token, which (unlike
// sessions/api tokens) is intentionally stored and returned in plaintext —
// it's a shareable link secret the owner needs to re-copy for testers, not
// a login credential, so hashing it the way 0009 hashes sessions would just
// make it unusable. The one thing worth fixing here is the comparison: a
// plain `===` short-circuits on the first mismatched byte, which leaks
// timing info about how many leading characters an attacker guessed right.
function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  // Length itself isn't secret (tokens are a fixed, known length), but
  // bail via a fixed-cost path rather than an early `return false`.
  const len = Math.max(aBytes.length, bBytes.length, 1);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < len; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- Rate limiting (D1-backed, coarse but enough to stop spam) ----------

async function rateLimited(
  env: Env,
  bucket: string,
  limit: number,
  windowSeconds: number
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - windowSeconds;

  const row = await env.DB.prepare(
    `SELECT COUNT(*) as c FROM rate_limit_hits WHERE bucket = ? AND created_at > ?`
  )
    .bind(bucket, cutoff)
    .first<{ c: number }>();

  if ((row?.c ?? 0) >= limit) return true;

  await env.DB.prepare(`INSERT INTO rate_limit_hits (bucket, created_at) VALUES (?, ?)`)
    .bind(bucket, now)
    .run();
  // Opportunistic cleanup so the table doesn't grow unbounded — cheap
  // because it's scoped to this one bucket.
  await env.DB.prepare(`DELETE FROM rate_limit_hits WHERE bucket = ? AND created_at <= ?`)
    .bind(bucket, cutoff)
    .run();

  return false;
}

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

// ---------- CSRF-lite: state-changing /api/* calls must come from us ----------
// Cookie is SameSite=Lax which already blocks most cross-site fetch/XHR in
// modern browsers, but that's not guaranteed everywhere — belt and braces.
function hasValidOrigin(request: Request, selfOrigin: string): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return true; // no Origin header (e.g. CLI/bearer-token calls) — nothing to check
  return origin === selfOrigin;
}

// ---------- Auth helpers ----------

function getCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : null;
}

async function getSessionUser(
  request: Request,
  env: Env
): Promise<{ id: string; email: string } | null> {
  const sessionId = getCookie(request, "session");
  if (!sessionId) return null;
  const sessionHash = await sha256Hex(sessionId);

  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `SELECT users.id as id, users.email as email
     FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.id = ? AND sessions.expires_at > ?`
  )
    .bind(sessionHash, now)
    .first<{ id: string; email: string }>();

  return row ?? null;
}

// For endpoints the CLI calls directly with an API token (no browser
// session available) — resolves the same way /:appId/upload and
// /:appId/versions already do.
async function getUserFromBearerToken(
  request: Request,
  env: Env
): Promise<{ id: string; email: string } | null> {
  const authHeader = request.headers.get("Authorization") ?? "";
  const token = authHeader.replace("Bearer ", "");
  if (!token) return null;
  const tokenHash = await sha256Hex(token);

  const row = await env.DB.prepare(
    `SELECT users.id as id, users.email as email
     FROM api_tokens
     JOIN users ON users.id = api_tokens.user_id
     WHERE api_tokens.token = ?`
  )
    .bind(tokenHash)
    .first<{ id: string; email: string }>();

  return row ?? null;
}

// Session cookie (dashboard) OR bearer token (CLI) — either identifies the user.
async function getAuthenticatedUser(
  request: Request,
  env: Env
): Promise<{ id: string; email: string } | null> {
  const sessionUser = await getSessionUser(request, env);
  if (sessionUser) return sessionUser;
  return getUserFromBearerToken(request, env);
}

// Resolves a bearer token straight to a user id, for the upload/versions
// routes which never go through a browser session.
async function getUserIdFromBearerToken(request: Request, env: Env): Promise<string | null> {
  const authHeader = request.headers.get("Authorization") ?? "";
  const token = authHeader.replace("Bearer ", "");
  if (!token) return null;
  const tokenHash = await sha256Hex(token);

  const row = await env.DB.prepare(`SELECT user_id FROM api_tokens WHERE token = ?`)
    .bind(tokenHash)
    .first<{ user_id: string }>();

  return row?.user_id ?? null;
}

// Early-access gate: until billing exists, access is granted manually
// (see users.access_granted). Once a payment processor is wired up, only
// what *sets* this flag changes (a webhook instead of a manual UPDATE) —
// every call site that checks it stays the same.
async function hasActiveAccess(userId: string, env: Env): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT access_granted FROM users WHERE id = ?`)
    .bind(userId)
    .first<{ access_granted: number }>();
  return row?.access_granted === 1;
}

async function sendMagicLinkEmail(env: Env, email: string, link: string): Promise<void> {
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Railcast <onboarding@resend.dev>",
      to: [email],
      subject: "Log in to Railcast",
      html: `<p>Click to log in:</p><p><a href="${link}">${link}</a></p><p>This link expires in 15 minutes.</p>`,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Resend API error (${resp.status}): ${text}`);
  }
}

async function sendWaitlistNotification(env: Env, email: string): Promise<void> {
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Railcast <onboarding@resend.dev>",
      to: ["casablanque@proton.me"],
      subject: "New early access request",
      html: `<p>${escapeXml(email)} requested early access to Railcast.</p>`,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Resend API error (${resp.status}): ${text}`);
  }
}

async function handleWaitlistRequest(request: Request, env: Env): Promise<Response> {
  let body: { email?: string };
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const email = body.email?.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return new Response("Valid email required", { status: 400 });
  }

  const ip = clientIp(request);
  if (
    (await rateLimited(env, `waitlist:ip:${ip}`, 10, 3600)) ||
    (await rateLimited(env, `waitlist:email:${email}`, 3, 3600))
  ) {
    return new Response("Too many requests — try again later", { status: 429 });
  }

  await env.DB.prepare(`INSERT INTO waitlist (id, email, created_at) VALUES (?, ?, unixepoch())`)
    .bind(crypto.randomUUID(), email)
    .run();

  await sendWaitlistNotification(env, email);

  return new Response(JSON.stringify({ ok: true, message: "Thanks — we'll be in touch" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleAuthRequest(request: Request, env: Env): Promise<Response> {
  let body: { email?: string };
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const email = body.email?.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return new Response("Valid email required", { status: 400 });
  }

  const ip = clientIp(request);
  if (
    (await rateLimited(env, `authreq:ip:${ip}`, 15, 3600)) ||
    (await rateLimited(env, `authreq:email:${email}`, 5, 3600))
  ) {
    // Same generic response either way — don't reveal that rate limiting
    // (vs. anything else) is what happened.
    return new Response(JSON.stringify({ ok: true, message: "Check your email" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = Math.floor(Date.now() / 1000) + 15 * 60;

  await env.DB.prepare(
    `INSERT INTO magic_links (token, email, expires_at, used) VALUES (?, ?, ?, 0)`
  )
    .bind(tokenHash, email, expiresAt)
    .run();

  const url = new URL(request.url);
  const link = `${url.origin}/auth/verify?token=${token}`;

  await sendMagicLinkEmail(env, email, link);

  return new Response(JSON.stringify({ ok: true, message: "Check your email" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleAuthVerify(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) {
    return new Response("Missing token", { status: 400 });
  }
  const tokenHash = await sha256Hex(token);

  const linkRow = await env.DB.prepare(
    `SELECT email, expires_at, used FROM magic_links WHERE token = ?`
  )
    .bind(tokenHash)
    .first<{ email: string; expires_at: number; used: number }>();

  const now = Math.floor(Date.now() / 1000);
  if (!linkRow || linkRow.used || linkRow.expires_at < now) {
    return new Response("Invalid or expired link", { status: 400 });
  }

  await env.DB.prepare(`UPDATE magic_links SET used = 1 WHERE token = ?`).bind(tokenHash).run();

  let user = await env.DB.prepare(`SELECT id FROM users WHERE email = ?`)
    .bind(linkRow.email)
    .first<{ id: string }>();

  if (!user) {
    const userId = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)`)
      .bind(userId, linkRow.email, now)
      .run();
    user = { id: userId };
  }

  const sessionId = randomToken();
  const sessionHash = await sha256Hex(sessionId);
  const sessionExpiresAt = now + 30 * 24 * 60 * 60;

  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`
  )
    .bind(sessionHash, user.id, sessionExpiresAt, now)
    .run();

  return new Response(null, {
    status: 302,
    headers: {
      Location: "/dashboard",
      "Set-Cookie": `session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${
        30 * 24 * 60 * 60
      }`,
    },
  });
}

function handleLogout(): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie": "session=; Path=/; HttpOnly; Max-Age=0",
    },
  });
}

// ---------- JSON API (used by the dashboard) ----------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleApiMe(request: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(request, env);
  if (!user) return jsonResponse({ error: "unauthorized" }, 401);
  return jsonResponse({ id: user.id, email: user.email });
}

async function handleApiListApps(request: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(request, env);
  if (!user) return jsonResponse({ error: "unauthorized" }, 401);

  const { results } = await env.DB.prepare(
    `SELECT id, name, signing_public_key, beta_token, created_at FROM apps WHERE owner_user_id = ? ORDER BY created_at DESC`
  )
    .bind(user.id)
    .all<{ id: string; name: string; signing_public_key: string; beta_token: string; created_at: number }>();

  return jsonResponse({ apps: results ?? [] });
}

async function handleApiCreateApp(request: Request, env: Env): Promise<Response> {
  const user = await getAuthenticatedUser(request, env);
  if (!user) return jsonResponse({ error: "unauthorized" }, 401);

  if (!hasValidOrigin(request, new URL(request.url).origin)) {
    return jsonResponse({ error: "bad_origin" }, 403);
  }

  if (!(await hasActiveAccess(user.id, env))) {
    return jsonResponse(
      {
        error: "access_not_granted",
        message: "Your account doesn't have access yet — request early access at railcast.casablanque.com",
      },
      402
    );
  }

  let body: { name?: string; signing_public_key?: string };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  // `name` is a free-text label only — never used in a URL, never checked
  // for uniqueness, so it can't collide with anyone else's app name.
  const name = (body.name?.trim() ?? "").slice(0, 128);
  const publicKey = body.signing_public_key?.trim() ?? "";

  if (!name || !publicKey) {
    return jsonResponse(
      { error: "invalid_input", message: "name and signing_public_key are required" },
      400
    );
  }

  // The public id is server-generated and opaque — retry on the
  // astronomically unlikely collision instead of trusting client input.
  let appId = randomAppId();
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await env.DB.prepare(`SELECT id FROM apps WHERE id = ?`).bind(appId).first();
    if (!existing) break;
    appId = randomAppId();
  }

  const betaToken = randomToken().slice(0, 32);

  await env.DB.prepare(
    `INSERT INTO apps (id, name, owner_email, owner_user_id, signing_public_key, beta_token, created_at)
     VALUES (?, ?, ?, ?, ?, ?, unixepoch())`
  )
    .bind(appId, name, user.email, user.id, publicKey, betaToken)
    .run();

  return jsonResponse(
    { id: appId, name, signing_public_key: publicKey, beta_token: betaToken },
    201
  );
}

async function handleApiListTokens(request: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(request, env);
  if (!user) return jsonResponse({ error: "unauthorized" }, 401);

  const { results } = await env.DB.prepare(
    `SELECT id, preview, created_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC`
  )
    .bind(user.id)
    .all<{ id: string; preview: string; created_at: number }>();

  return jsonResponse({ tokens: results ?? [] });
}

async function handleApiCreateToken(request: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(request, env);
  if (!user) return jsonResponse({ error: "unauthorized" }, 401);

  if (!hasValidOrigin(request, new URL(request.url).origin)) {
    return jsonResponse({ error: "bad_origin" }, 403);
  }

  const id = crypto.randomUUID();
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const preview = `${token.slice(0, 8)}…`;
  await env.DB.prepare(
    `INSERT INTO api_tokens (id, token, preview, user_id, created_at) VALUES (?, ?, ?, ?, unixepoch())`
  )
    .bind(id, tokenHash, preview, user.id)
    .run();

  // Shown once — the dashboard must display and copy it immediately, we
  // only ever stored the hash so we genuinely cannot show it again.
  return jsonResponse({ id, token }, 201);
}

async function handleApiDeleteToken(
  request: Request,
  env: Env,
  tokenId: string
): Promise<Response> {
  const user = await getSessionUser(request, env);
  if (!user) return jsonResponse({ error: "unauthorized" }, 401);

  if (!hasValidOrigin(request, new URL(request.url).origin)) {
    return jsonResponse({ error: "bad_origin" }, 403);
  }

  const result = await env.DB.prepare(`DELETE FROM api_tokens WHERE id = ? AND user_id = ?`)
    .bind(tokenId, user.id)
    .run();

  if (result.meta.changes === 0) {
    return jsonResponse({ error: "not_found" }, 404);
  }
  return new Response(null, { status: 204 });
}

async function handleApiDeleteApp(request: Request, env: Env, appId: string): Promise<Response> {
  const user = await getAuthenticatedUser(request, env);
  if (!user) return jsonResponse({ error: "unauthorized" }, 401);

  if (!hasValidOrigin(request, new URL(request.url).origin)) {
    return jsonResponse({ error: "bad_origin" }, 403);
  }

  const appRow = await env.DB.prepare(`SELECT owner_user_id FROM apps WHERE id = ?`)
    .bind(appId)
    .first<{ owner_user_id: string }>();

  // Matches requireAppOwnership's split below (see its comment): the id
  // space is a random 71-bit string, so telling a wrong-id request apart
  // from a not-your-app request doesn't help enumeration either way — we'd
  // previously merged both into 404 here while requireAppOwnership split
  // them, which was an inconsistency rather than a deliberate choice.
  if (!appRow) {
    return jsonResponse({ error: "not_found" }, 404);
  }
  if (appRow.owner_user_id !== user.id) {
    return jsonResponse({ error: "forbidden" }, 403);
  }

  // Versions first (no ON DELETE CASCADE on this FK — D1 doesn't enforce
  // foreign keys by default anyway, so do it explicitly and in the safe
  // order regardless).
  await env.DB.prepare(`DELETE FROM versions WHERE app_id = ?`).bind(appId).run();
  await env.DB.prepare(`DELETE FROM apps WHERE id = ?`).bind(appId).run();

  // Best-effort cleanup of the uploaded build artifacts in R2. Not
  // transactional with the D1 deletes above (R2 and D1 are separate
  // systems) — if this partially fails, we've still removed the app from
  // every API surface (appcast, listing, ownership checks), which is what
  // actually matters; a few orphaned objects under a now-unreachable
  // prefix cost storage, not security.
  let cursor: string | undefined;
  do {
    const listed = await env.BUILDS.list({ prefix: `${appId}/`, cursor });
    if (listed.objects.length > 0) {
      await env.BUILDS.delete(listed.objects.map((o) => o.key));
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return new Response(null, { status: 204 });
}

async function requireAppOwnership(
  request: Request,
  env: Env,
  appId: string
): Promise<{ ok: true } | { ok: false; response: Response }> {
  const userId = await getUserIdFromBearerToken(request, env);
  if (!userId) {
    return { ok: false, response: new Response("Unauthorized", { status: 401 }) };
  }

  const appRow = await env.DB.prepare(`SELECT owner_user_id FROM apps WHERE id = ?`)
    .bind(appId)
    .first<{ owner_user_id: string }>();

  if (!appRow) {
    // Distinct from 403 on purpose: this tells the CLI (and the person
    // typing the wrong id) that the id itself is wrong, not that they
    // lack permission on a real app — much easier to debug. This doesn't
    // meaningfully help an attacker enumerate other people's app ids: the
    // id space is a random 12-char string (~71 bits), so guessing one
    // that exists is already infeasible regardless of how the error
    // differs for a hit vs a miss.
    return { ok: false, response: new Response("App not found", { status: 404 }) };
  }
  if (appRow.owner_user_id !== userId) {
    return { ok: false, response: new Response("Forbidden", { status: 403 }) };
  }

  return { ok: true };
}

async function handleUpload(
  request: Request,
  env: Env,
  appId: string,
  filename: string
): Promise<Response> {
  const auth = await requireAppOwnership(request, env, appId);
  if (!auth.ok) return auth.response;

  if (!request.body) {
    return new Response("Missing body", { status: 400 });
  }

  const fileKey = `${appId}/${filename}`;
  const obj = await env.BUILDS.put(fileKey, request.body);

  return new Response(JSON.stringify({ file_key: fileKey, file_size: obj?.size ?? null }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

interface CreateVersionBody {
  version?: string;
  build_number?: number;
  channel?: string;
  file_key?: string;
  file_size?: number;
  sha256?: string;
  signature?: string;
  release_notes?: string;
}

async function handleCreateVersion(request: Request, env: Env, appId: string): Promise<Response> {
  const auth = await requireAppOwnership(request, env, appId);
  if (!auth.ok) return auth.response;

  let body: CreateVersionBody;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const { version, build_number, file_key, file_size, sha256, signature, release_notes } = body;
  const channel = body.channel ?? "stable";

  if (!version || !build_number || !file_key || !file_size || !sha256 || !signature) {
    return new Response(
      "Missing required fields: version, build_number, file_key, file_size, sha256, signature",
      { status: 400 }
    );
  }

  if (!file_key.startsWith(`${appId}/`)) {
    return new Response("file_key does not belong to this app", { status: 400 });
  }
  const head = await env.BUILDS.head(file_key);
  if (!head) {
    return new Response("file_key not found in storage — upload first", { status: 400 });
  }

  // Sparkle (and most updaters) trust build_number as a strictly increasing
  // ordering — publishing one that's <= the current latest on this channel
  // would either silently vanish (fine) or, worse, get treated as "newer"
  // by a client that's confused about ordering. Enforce it server-side
  // rather than trusting the CLI/build script to always get it right.
  const latest = await env.DB.prepare(
    `SELECT MAX(build_number) as max_build FROM versions WHERE app_id = ? AND channel = ?`
  )
    .bind(appId, channel)
    .first<{ max_build: number | null }>();

  if (latest?.max_build != null && build_number <= latest.max_build) {
    return new Response(
      `build_number ${build_number} is not greater than the current latest (${latest.max_build}) on channel "${channel}"`,
      { status: 409 }
    );
  }

  const createdAt = Math.floor(Date.now() / 1000);

  await env.DB.prepare(
    `INSERT INTO versions
      (app_id, channel, version, build_number, file_key, file_size, sha256, signature, release_notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      appId,
      channel,
      version,
      build_number,
      file_key,
      file_size,
      sha256,
      signature,
      release_notes ?? null,
      createdAt
    )
    .run();

  return new Response(
    JSON.stringify({
      app_id: appId,
      channel,
      version,
      build_number,
      appcast_url: `/${appId}/appcast.xml?channel=${encodeURIComponent(channel)}`,
    }),
    { status: 201, headers: { "Content-Type": "application/json" } }
  );
}

async function handleAppcast(request: Request, env: Env, appId: string): Promise<Response> {
  const url = new URL(request.url);
  const channel = url.searchParams.get("channel") ?? "stable";

  // Non-stable channels need the app's beta token — the channel name
  // itself isn't a secret, so without this anyone who finds the (opaque,
  // but now-published) appcast URL could also read the beta feed.
  if (channel !== "stable") {
    const appRow = await env.DB.prepare(`SELECT beta_token FROM apps WHERE id = ?`)
      .bind(appId)
      .first<{ beta_token: string | null }>();

    const suppliedToken = url.searchParams.get("token") ?? "";
    if (!appRow || !appRow.beta_token || !timingSafeEqual(suppliedToken, appRow.beta_token)) {
      // Same 404 as "not found" — don't reveal whether the app/channel
      // exists to someone without the token.
      return new Response("Not found", { status: 404 });
    }
  }

  const { results } = await env.DB.prepare(
    `SELECT version, build_number, file_key, file_size, sha256, signature, release_notes, created_at
     FROM versions
     WHERE app_id = ? AND channel = ?
     ORDER BY build_number DESC
     LIMIT 10`
  )
    .bind(appId, channel)
    .all<VersionRow>();

  if (!results || results.length === 0) {
    return new Response("Not found", { status: 404 });
  }

  const xml = renderAppcast(appId, results, env.PUBLIC_FILE_BASE_URL, `${url.origin}/${appId}/appcast.xml`);

  return new Response(xml, {
    status: 200,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}

// ---------- Router ----------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/logout" && request.method === "GET") {
      return handleLogout();
    }
    if (url.pathname === "/api/waitlist" && request.method === "POST") {
      return handleWaitlistRequest(request, env);
    }
    if (url.pathname === "/auth/request" && request.method === "POST") {
      return handleAuthRequest(request, env);
    }
    if (url.pathname === "/auth/verify" && request.method === "GET") {
      return handleAuthVerify(request, env);
    }

    if (url.pathname.startsWith("/api/")) {
      if (url.pathname === "/api/me" && request.method === "GET") {
        return handleApiMe(request, env);
      }
      if (url.pathname === "/api/apps" && request.method === "GET") {
        return handleApiListApps(request, env);
      }
      if (url.pathname === "/api/apps" && request.method === "POST") {
        return handleApiCreateApp(request, env);
      }
      const appDeleteMatch = url.pathname.match(/^\/api\/apps\/([a-zA-Z0-9_-]+)$/);
      if (appDeleteMatch && request.method === "DELETE") {
        return handleApiDeleteApp(request, env, appDeleteMatch[1]);
      }
      if (url.pathname === "/api/tokens" && request.method === "GET") {
        return handleApiListTokens(request, env);
      }
      if (url.pathname === "/api/tokens" && request.method === "POST") {
        return handleApiCreateToken(request, env);
      }
      const tokenDeleteMatch = url.pathname.match(/^\/api\/tokens\/([a-zA-Z0-9-]+)$/);
      if (tokenDeleteMatch && request.method === "DELETE") {
        return handleApiDeleteToken(request, env, tokenDeleteMatch[1]);
      }
      return jsonResponse({ error: "not_found" }, 404);
    }

    const uploadMatch = url.pathname.match(/^\/([a-zA-Z0-9_-]+)\/upload\/([a-zA-Z0-9_.\-]+)$/);
    if (uploadMatch && request.method === "PUT") {
      const [, appId, filename] = uploadMatch;
      return handleUpload(request, env, appId, filename);
    }

    const appcastMatch = url.pathname.match(/^\/([a-zA-Z0-9_-]+)\/appcast\.xml$/);
    if (appcastMatch && request.method === "GET") {
      const [, appId] = appcastMatch;
      return handleAppcast(request, env, appId);
    }

    const versionsMatch = url.pathname.match(/^\/([a-zA-Z0-9_-]+)\/versions$/);
    if (versionsMatch && request.method === "POST") {
      const [, appId] = versionsMatch;
      return handleCreateVersion(request, env, appId);
    }

    return new Response("Railcast API is alive", { status: 200 });
  },
};
