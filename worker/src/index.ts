export interface Env {
  DB: D1Database;
  BUILDS: R2Bucket;
  ASSETS: Fetcher;
  PUBLIC_FILE_BASE_URL: string;
  RESEND_API_KEY: string;
  // Optional; string because wrangler [vars] are always strings. Parsed
  // with DEFAULT_MAX_UPLOAD_BYTES as the fallback — see maxUploadBytes().
  MAX_UPLOAD_BYTES?: string;
}

// Fallback when MAX_UPLOAD_BYTES isn't configured. 500 MiB comfortably
// covers a real desktop-app build artifact (installers, signed bundles)
// without leaving uploads effectively unbounded, which — for a public
// service where a valid API token is the only gate — is an abuse/cost
// vector: R2 storage and class-A request costs scale with whatever
// clients are willing to upload.
const DEFAULT_MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

function maxUploadBytes(env: Env): number {
  const parsed = Number(env.MAX_UPLOAD_BYTES);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_UPLOAD_BYTES;
}

interface VersionRow {
  version: string;
  build_number: number;
  file_key: string;
  file_size: number;
  sha256: string;
  signature: string;
  release_notes: string | null;
  critical: number;
  phased_rollout_interval: number | null;
  created_at: number;
}

// How many of the most recent builds on a channel actually get served by
// appcast.xml (see handleAppcast's query). This is a single source of
// truth on purpose: it's also returned from handleListReleases as
// history_limit, so the CLI's `railcast cleanup` retention logic reads
// this number from the server instead of hardcoding its own guess — the
// two can never drift apart and quietly disagree about what "old" means.
const APPCAST_HISTORY_LIMIT = 10;

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// CDATA has no escape mechanism of its own — the only character sequence
// that's actually illegal inside <![CDATA[ ... ]]> is the closing marker
// "]]>" itself. If release_notes contains that sequence verbatim, it would
// prematurely terminate the CDATA block and let the rest of the string be
// parsed as XML markup, corrupting (or injecting into) the appcast.
//
// The standard fix is to split any embedded "]]>" across two adjacent
// CDATA sections: "]]>" becomes "]]" + "]]><![CDATA[" + ">", i.e.
// "]]]]><![CDATA[>". Concatenated, adjacent CDATA sections are equivalent
// to one continuous block from the XML parser's point of view, so this is
// lossless — the exact original bytes come back out on the other side.
function safeCData(s: string): string {
  return s.replace(/]]>/g, "]]]]><![CDATA[>");
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
        ? `\n      <description><![CDATA[${safeCData(r.release_notes)}]]></description>`
        : "";
      const critical = r.critical ? `\n      <sparkle:criticalUpdate/>` : "";
      const phasedRollout =
        r.phased_rollout_interval != null
          ? `\n      <sparkle:phasedRolloutInterval>${r.phased_rollout_interval}</sparkle:phasedRolloutInterval>`
          : "";
      return `    <item>
      <title>Version ${escapeXml(r.version)}</title>
      <pubDate>${pubDate}</pubDate>
      <sparkle:version>${r.build_number}</sparkle:version>
      <sparkle:shortVersionString>${escapeXml(r.version)}</sparkle:shortVersionString>${description}${critical}${phasedRollout}
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
function randomAppId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => BASE62[b % BASE62.length]).join("");
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bufferToHex(digest);
}

function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;

// ---------- Password hashing ----------
// PBKDF2 via Web Crypto — available natively on Workers, no extra
// dependency (bcrypt/argon2 packages generally need Node APIs we don't
// have here). 100k iterations is a reasonable floor for PBKDF2-SHA256.

const PBKDF2_ITERATIONS = 100_000;
const MIN_PASSWORD_LENGTH = 8;

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

// Constant-time-ish comparison so a failed login can't be timed
// character-by-character against a real hash.
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function derivePbkdf2Hex(password: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    key,
    256
  );
  return bufferToHex(bits);
}

// Stored as "salt:hash", both hex — self-contained, no separate salt column.
async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePbkdf2Hex(password, salt);
  return `${bufferToHex(salt.buffer)}:${hash}`;
}

// Fixed-shape dummy so verifying against a non-existent user still does a
// full PBKDF2 pass — login timing shouldn't reveal whether the email exists.
const DUMMY_PASSWORD_HASH = `${"00".repeat(16)}:${"00".repeat(32)}`;

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const computed = await derivePbkdf2Hex(password, hexToBytes(saltHex));
  return timingSafeEqualHex(computed, hashHex);
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

interface BearerIdentity {
  userId: string;
  email: string;
  // The app this token is scoped to, or null for an old-style,
  // account-wide token (see migration 0009_per_app_tokens.sql).
  appId: string | null;
  // 'publish' can upload/register versions/delete apps; 'read' can only
  // hit read-only endpoints. See migration 0010_token_expiry_scope.sql.
  scope: "publish" | "read";
}

async function getBearerIdentity(request: Request, env: Env): Promise<BearerIdentity | null> {
  const authHeader = request.headers.get("Authorization") ?? "";
  const token = authHeader.replace("Bearer ", "");
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const now = Math.floor(Date.now() / 1000);

  // expires_at IS NULL means "never expires" — matches every token issued
  // before this feature existed, and any new token created without a TTL.
  // An expired token is treated as if it doesn't exist at all (401, same
  // as an unknown token), rather than a distinct "expired" error, so this
  // filters it out of the SELECT itself instead of checking afterward.
  const row = await env.DB.prepare(
    `SELECT users.id as id, users.email as email, api_tokens.app_id as app_id,
            api_tokens.scope as scope
     FROM api_tokens
     JOIN users ON users.id = api_tokens.user_id
     WHERE api_tokens.token = ? AND (api_tokens.expires_at IS NULL OR api_tokens.expires_at > ?)`
  )
    .bind(tokenHash, now)
    .first<{ id: string; email: string; app_id: string | null; scope: "publish" | "read" }>();

  if (!row) return null;

  // Best-effort — a stolen-but-unused token being visibly different from
  // one still in active use (dashboard "last used" column) is a nice
  // signal, but must never be the reason a legitimate request fails.
  await env.DB.prepare(`UPDATE api_tokens SET last_used_at = ? WHERE token = ?`)
    .bind(now, tokenHash)
    .run()
    .catch(() => {});

  return { userId: row.id, email: row.email, appId: row.app_id, scope: row.scope };
}

// Note: there is no combined "session or bearer" helper anymore — the two
// call sites that used to share one (handleApiCreateApp, handleApiDeleteApp)
// need to see whether a bearer token is per-app scoped, so they resolve
// session vs. bearer identity themselves instead of going through a helper
// that discards that distinction.

async function sendTransactionalEmail(
  env: Env,
  email: string,
  subject: string,
  html: string
): Promise<void> {
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Railcast <onboarding@resend.dev>",
      to: [email],
      subject,
      html,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Resend API error (${resp.status}): ${text}`);
  }
}

async function sendMagicLinkEmail(env: Env, email: string, link: string): Promise<void> {
  await sendTransactionalEmail(
    env,
    email,
    "Log in to Railcast",
    `<p>Click to log in:</p><p><a href="${link}">${link}</a></p><p>This link expires in 15 minutes.</p>`
  );
}

async function sendVerificationEmail(env: Env, email: string, link: string): Promise<void> {
  await sendTransactionalEmail(
    env,
    email,
    "Confirm your Railcast account",
    `<p>Click to confirm your email and finish signing up:</p><p><a href="${link}">${link}</a></p><p>This link expires in 60 minutes.</p>`
  );
}

function sessionCookie(sessionId: string): string {
  return `session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${
    30 * 24 * 60 * 60
  }`;
}

async function issueSession(env: Env, userId: string): Promise<string> {
  const sessionId = randomToken();
  const sessionHash = await sha256Hex(sessionId);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 30 * 24 * 60 * 60;

  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`
  )
    .bind(sessionHash, userId, expiresAt, now)
    .run();

  return sessionId;
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
  const now = Math.floor(Date.now() / 1000);

  // Atomically consume the link: the UPDATE's WHERE clause re-checks
  // used = 0 and expiry at the same time it flips used to 1, so two
  // near-simultaneous requests for the same token can't both read
  // "not used yet" before either write lands — SQLite/D1 serializes
  // writes to a row, so at most one of these statements can match and
  // return a row. RETURNING lets us get the email back from the same
  // atomic statement instead of a separate SELECT beforehand.
  const linkRow = await env.DB.prepare(
    `UPDATE magic_links SET used = 1
     WHERE token = ? AND used = 0 AND expires_at > ?
     RETURNING email`
  )
    .bind(tokenHash, now)
    .first<{ email: string }>();

  if (!linkRow) {
    return new Response("Invalid or expired link", { status: 400 });
  }

  let user = await env.DB.prepare(`SELECT id FROM users WHERE email = ?`)
    .bind(linkRow.email)
    .first<{ id: string }>();

  if (!user) {
    const userId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO users (id, email, email_verified, created_at) VALUES (?, ?, 1, ?)`
    )
      .bind(userId, linkRow.email, now)
      .run();
    user = { id: userId };
  } else {
    // Clicking a magic link proves inbox ownership regardless of how the
    // account originally got created — e.g. someone who registered with a
    // password but never confirmed it can also verify this way.
    await env.DB.prepare(`UPDATE users SET email_verified = 1 WHERE id = ?`)
      .bind(user.id)
      .run();
  }

  const sessionId = await issueSession(env, user.id);

  return new Response(null, {
    status: 302,
    headers: {
      Location: "/dashboard",
      "Set-Cookie": sessionCookie(sessionId),
    },
  });
}

// Email/password sign-up. Creates the user if the email is new, or attaches
// a password to an existing magic-link-only account (so people who signed
// up passwordlessly aren't locked out of switching later). Fails if the
// account already has a password — use /auth/login instead.
//
// A brand-new email/password account starts unverified and gets no session
// yet — we don't know this person actually controls that inbox until they
// click the confirmation link. Attaching a password to an existing
// magic-link account skips this: getting that far already proved inbox
// ownership at least once.
async function handleAuthRegister(request: Request, env: Env): Promise<Response> {
  let body: { email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const email = body.email?.trim().toLowerCase();
  const password = body.password ?? "";

  if (!email || !email.includes("@")) {
    return new Response("Valid email required", { status: 400 });
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return new Response(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`, {
      status: 400,
    });
  }

  const ip = clientIp(request);
  if (
    (await rateLimited(env, `authregister:ip:${ip}`, 20, 3600)) ||
    (await rateLimited(env, `authregister:email:${email}`, 5, 3600))
  ) {
    return new Response("Too many attempts, try again later", { status: 429 });
  }

  const existing = await env.DB.prepare(
    `SELECT id, password_hash, email_verified FROM users WHERE email = ?`
  )
    .bind(email)
    .first<{ id: string; password_hash: string | null; email_verified: number }>();

  if (existing?.password_hash) {
    return new Response("An account with this email already exists", { status: 409 });
  }

  const passwordHash = await hashPassword(password);
  const now = Math.floor(Date.now() / 1000);
  const url = new URL(request.url);

  if (existing) {
    // Magic-link account attaching a password — already verified, log in now.
    await env.DB.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`)
      .bind(passwordHash, existing.id)
      .run();

    const sessionId = await issueSession(env, existing.id);
    return new Response(JSON.stringify({ ok: true, verification_required: false }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Set-Cookie": sessionCookie(sessionId) },
    });
  }

  const userId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO users (id, email, password_hash, email_verified, created_at) VALUES (?, ?, ?, 0, ?)`
  )
    .bind(userId, email, passwordHash, now)
    .run();

  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = now + 60 * 60;
  await env.DB.prepare(
    `INSERT INTO email_verifications (token, user_id, expires_at, used) VALUES (?, ?, ?, 0)`
  )
    .bind(tokenHash, userId, expiresAt)
    .run();

  const link = `${url.origin}/auth/verify-email?token=${token}`;
  await sendVerificationEmail(env, email, link);

  // No session yet — the account can't log in until the link is clicked.
  return new Response(JSON.stringify({ ok: true, verification_required: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleVerifyEmail(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) {
    return new Response("Missing token", { status: 400 });
  }
  const tokenHash = await sha256Hex(token);
  const now = Math.floor(Date.now() / 1000);

  // Same atomic-consumption pattern as magic links (see handleAuthVerify):
  // the WHERE clause on the UPDATE re-checks used = 0 / expiry at write
  // time, so two concurrent requests replaying the same verification
  // link can't both succeed.
  const row = await env.DB.prepare(
    `UPDATE email_verifications SET used = 1
     WHERE token = ? AND used = 0 AND expires_at > ?
     RETURNING user_id`
  )
    .bind(tokenHash, now)
    .first<{ user_id: string }>();

  if (!row) {
    return new Response("Invalid or expired link", { status: 400 });
  }

  await env.DB.prepare(`UPDATE users SET email_verified = 1 WHERE id = ?`)
    .bind(row.user_id)
    .run();

  const sessionId = await issueSession(env, row.user_id);

  return new Response(null, {
    status: 302,
    headers: {
      Location: "/dashboard",
      "Set-Cookie": sessionCookie(sessionId),
    },
  });
}

async function handleAuthLogin(request: Request, env: Env): Promise<Response> {
  let body: { email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const email = body.email?.trim().toLowerCase();
  const password = body.password ?? "";
  if (!email || !password) {
    return new Response("Email and password required", { status: 400 });
  }

  const ip = clientIp(request);
  if (
    (await rateLimited(env, `authlogin:ip:${ip}`, 20, 3600)) ||
    (await rateLimited(env, `authlogin:email:${email}`, 10, 3600))
  ) {
    return new Response("Too many attempts, try again later", { status: 429 });
  }

  const user = await env.DB.prepare(
    `SELECT id, password_hash, email_verified FROM users WHERE email = ?`
  )
    .bind(email)
    .first<{ id: string; password_hash: string | null; email_verified: number }>();

  // Always run the PBKDF2 comparison, even for an unknown email or a
  // magic-link-only account with no password set, so response timing
  // doesn't leak which case we hit.
  const valid = await verifyPassword(password, user?.password_hash ?? DUMMY_PASSWORD_HASH);

  if (!user || !user.password_hash || !valid) {
    return new Response("Invalid email or password", { status: 401 });
  }

  if (!user.email_verified) {
    return new Response("Please confirm your email address first — check your inbox", {
      status: 403,
    });
  }

  const sessionId = await issueSession(env, user.id);

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Set-Cookie": sessionCookie(sessionId) },
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
  const sessionUser = await getSessionUser(request, env);
  const identity = sessionUser ? null : await getBearerIdentity(request, env);
  const userId = sessionUser?.id ?? identity?.userId;
  if (!userId) return jsonResponse({ error: "unauthorized" }, 401);

  // A per-app scoped token should only ever learn about the one app it's
  // scoped to — listing every app on the account would leak the existence
  // (ids, names) of apps that token has no business knowing about.
  const scopedAppId = identity?.appId ?? null;

  const { results } = scopedAppId
    ? await env.DB.prepare(
        `SELECT id, name, signing_public_key, beta_token, created_at FROM apps
         WHERE owner_user_id = ? AND id = ? ORDER BY created_at DESC`
      )
        .bind(userId, scopedAppId)
        .all<{ id: string; name: string; signing_public_key: string; beta_token: string; created_at: number }>()
    : await env.DB.prepare(
        `SELECT id, name, signing_public_key, beta_token, created_at FROM apps
         WHERE owner_user_id = ? ORDER BY created_at DESC`
      )
        .bind(userId)
        .all<{ id: string; name: string; signing_public_key: string; beta_token: string; created_at: number }>();

  return jsonResponse({ apps: results ?? [] });
}

async function handleApiCreateApp(request: Request, env: Env): Promise<Response> {
  const sessionUser = await getSessionUser(request, env);
  const identity = sessionUser ? null : await getBearerIdentity(request, env);
  const user = sessionUser ?? (identity ? { id: identity.userId, email: identity.email } : null);
  if (!user) return jsonResponse({ error: "unauthorized" }, 401);

  // A per-app token is scoped to the one app it was created for — using it
  // to mint a brand-new app would be a way around that scoping entirely,
  // so this is session-or-account-wide-token only.
  if (identity && identity.appId !== null) {
    return jsonResponse(
      { error: "forbidden", message: "This token is scoped to a single app and can't create new apps" },
      403
    );
  }
  if (identity && identity.scope !== "publish") {
    return jsonResponse({ error: "forbidden", message: "This token does not have publish scope" }, 403);
  }

  if (!hasValidOrigin(request, new URL(request.url).origin)) {
    return jsonResponse({ error: "bad_origin" }, 403);
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
    `SELECT id, preview, app_id, scope, expires_at, last_used_at, created_at
     FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC`
  )
    .bind(user.id)
    .all<{
      id: string;
      preview: string;
      app_id: string | null;
      scope: string;
      expires_at: number | null;
      last_used_at: number | null;
      created_at: number;
    }>();

  return jsonResponse({ tokens: results ?? [] });
}

async function handleApiCreateToken(request: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(request, env);
  if (!user) return jsonResponse({ error: "unauthorized" }, 401);

  if (!hasValidOrigin(request, new URL(request.url).origin)) {
    return jsonResponse({ error: "bad_origin" }, 403);
  }

  let body: { app_id?: string; scope?: string; expires_in_days?: number } = {};
  try {
    // Body is optional — an empty body (or these fields omitted from it)
    // keeps creating the old-style account-wide, publish-scoped,
    // never-expiring token, same as before this feature existed. Read as
    // text first so an empty body (which isn't valid JSON on its own)
    // doesn't get treated as a parse error.
    const raw = await request.text();
    if (raw.trim().length > 0) {
      body = JSON.parse(raw);
    }
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  const appId = body.app_id?.trim() || null;
  if (appId !== null) {
    // Scoping a token to an app you don't own would let you hand someone
    // else's app_id to a token that's otherwise indistinguishable from a
    // legitimate scoped one — reject up front rather than creating a
    // token that can never actually authorize anything.
    const appRow = await env.DB.prepare(`SELECT owner_user_id FROM apps WHERE id = ?`)
      .bind(appId)
      .first<{ owner_user_id: string }>();
    if (!appRow || appRow.owner_user_id !== user.id) {
      return jsonResponse({ error: "not_found", message: "No such app" }, 404);
    }
  }

  const scope = body.scope ?? "publish";
  if (scope !== "publish" && scope !== "read") {
    return jsonResponse(
      { error: "invalid_input", message: "scope must be 'publish' or 'read'" },
      400
    );
  }

  let expiresAt: number | null = null;
  if (body.expires_in_days !== undefined) {
    const days = body.expires_in_days;
    // Upper bound is arbitrary but deliberate: a token that "expires" 50
    // years out is really just an unbounded token with extra steps, and
    // catches an obvious unit mistake (someone passing hours or minutes
    // meaning to pass days).
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      return jsonResponse(
        { error: "invalid_input", message: "expires_in_days must be an integer between 1 and 3650" },
        400
      );
    }
    expiresAt = Math.floor(Date.now() / 1000) + days * 86400;
  }

  const id = crypto.randomUUID();
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const preview = `${token.slice(0, 8)}…`;
  await env.DB.prepare(
    `INSERT INTO api_tokens (id, token, preview, user_id, app_id, scope, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())`
  )
    .bind(id, tokenHash, preview, user.id, appId, scope, expiresAt)
    .run();

  // Shown once — the dashboard must display and copy it immediately, we
  // only ever stored the hash so we genuinely cannot show it again.
  return jsonResponse({ id, token, app_id: appId, scope, expires_at: expiresAt }, 201);
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
  const sessionUser = await getSessionUser(request, env);
  const identity = sessionUser ? null : await getBearerIdentity(request, env);
  const userId = sessionUser?.id ?? identity?.userId;
  if (!userId) return jsonResponse({ error: "unauthorized" }, 401);

  if (!hasValidOrigin(request, new URL(request.url).origin)) {
    return jsonResponse({ error: "bad_origin" }, 403);
  }

  const appRow = await env.DB.prepare(`SELECT owner_user_id FROM apps WHERE id = ?`)
    .bind(appId)
    .first<{ owner_user_id: string }>();

  if (!appRow) {
    // Distinct from 403 on purpose, same reasoning as requireAppOwnership:
    // the id space is a random 71-bit string, so a 404-vs-403 split here
    // doesn't meaningfully help enumeration, and it's the same signal the
    // CLI's upload/versions endpoints already give for a bad id.
    return jsonResponse({ error: "not_found" }, 404);
  }
  if (appRow.owner_user_id !== userId) {
    return jsonResponse({ error: "forbidden" }, 403);
  }
  // Same per-app scoping as requireAppOwnership: a token scoped to one app
  // (identity.appId set) must not be able to delete a *different* app the
  // account happens to also own. Deleting the one app it's scoped to is
  // fine — that's within the token's stated scope.
  if (identity && identity.appId !== null && identity.appId !== appId) {
    return jsonResponse({ error: "forbidden", message: "This token is scoped to a different app" }, 403);
  }
  if (identity && identity.scope !== "publish") {
    return jsonResponse({ error: "forbidden", message: "This token does not have publish scope" }, 403);
  }

  // Versions first (no ON DELETE CASCADE on this FK — D1 doesn't enforce
  // foreign keys by default anyway, so do it explicitly and in the safe
  // order regardless).
  await env.DB.prepare(`DELETE FROM versions WHERE app_id = ?`).bind(appId).run();
  // A token scoped to this app (app_id = appId) would otherwise violate
  // api_tokens.app_id's foreign key on apps(id) once the app row below is
  // gone — and such a token would be useless afterward anyway, since every
  // ownership check 404s on a nonexistent app_id.
  await env.DB.prepare(`DELETE FROM api_tokens WHERE app_id = ?`).bind(appId).run();
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
  appId: string,
  requiredScope: "read" | "publish" = "publish"
): Promise<{ ok: true } | { ok: false; response: Response }> {
  const identity = await getBearerIdentity(request, env);
  if (!identity) {
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
  if (appRow.owner_user_id !== identity.userId) {
    return { ok: false, response: new Response("Forbidden", { status: 403 }) };
  }
  // A per-app token (appId set at creation — see handleApiCreateToken)
  // must not be usable against any other app, even one the same account
  // owns. This is the whole point of scoping: a leaked token only ever
  // exposes the one app it was issued for. NULL means an old-style,
  // account-wide token, kept working for backward compatibility.
  if (identity.appId !== null && identity.appId !== appId) {
    return {
      ok: false,
      response: new Response("This token is scoped to a different app", { status: 403 }),
    };
  }
  // 'publish' is a superset of 'read' — a publish-scoped token can do
  // anything a read-scoped one can, but not vice versa. Endpoints that
  // mutate anything (upload, register a version, delete an app) require
  // 'publish'; read-only endpoints (listing releases) pass "read" here and
  // accept either scope.
  if (requiredScope === "publish" && identity.scope !== "publish") {
    return {
      ok: false,
      response: new Response("This token does not have publish scope", { status: 403 }),
    };
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

  const limit = maxUploadBytes(env);

  // R2's put() only accepts a ReadableStream whose length it can determine
  // up front — the original request/response body, or a FixedLengthStream.
  // Anything derived from it via pipeThrough()/TransformStream loses that
  // property and put() throws "Provided readable stream must have a known
  // length" for every upload, not just oversized ones. So the limit has to
  // be enforced around the stream, via Content-Length, rather than by
  // wrapping the stream itself — request.body is passed to put() untouched
  // below.
  const contentLengthHeader = request.headers.get("Content-Length");
  if (contentLengthHeader === null) {
    return new Response("Content-Length header is required for uploads", { status: 411 });
  }
  const declaredLength = Number(contentLengthHeader);
  if (!Number.isFinite(declaredLength) || declaredLength < 0) {
    return new Response("Content-Length header is required for uploads", { status: 411 });
  }
  if (declaredLength > limit) {
    return new Response(
      `Upload too large: ${declaredLength} bytes exceeds the ${limit}-byte limit`,
      { status: 413 }
    );
  }

  // Required so R2 verifies the bytes as they're written, not after the
  // fact — without this, handleCreateVersion below has nothing to check
  // the client-claimed sha256 against, since R2 only records a checksum
  // for a hash algorithm it was actually asked to verify at put() time.
  const claimedSha256 = request.headers.get("X-Sha256")?.toLowerCase() ?? "";
  if (!SHA256_HEX_RE.test(claimedSha256)) {
    return new Response("Missing or malformed X-Sha256 header (expected 64 hex chars)", {
      status: 400,
    });
  }

  const fileKey = `${appId}/${filename}`;

  // A file_key that's already attached to a published version is
  // immutable — otherwise the appcast could keep pointing at a signed,
  // checksummed version record while the bytes underneath it silently
  // change on a later re-upload to the same filename.
  const alreadyPublished = await env.DB.prepare(`SELECT 1 FROM versions WHERE file_key = ?`)
    .bind(fileKey)
    .first();
  if (alreadyPublished) {
    return new Response(
      "This file_key is already attached to a published version — use a new filename",
      { status: 409 }
    );
  }

  let obj;
  try {
    obj = await env.BUILDS.put(fileKey, request.body, { sha256: claimedSha256 });
  } catch {
    return new Response("Uploaded bytes don't match the X-Sha256 header", { status: 400 });
  }
  if (!obj) {
    return new Response("Uploaded bytes don't match the X-Sha256 header", { status: 400 });
  }

  // Defense in depth: Content-Length is caller-supplied, and while the
  // Workers runtime generally holds a request's body to the length it
  // declared, we don't want a mismatched or lied-about header to be the
  // only thing standing between a client and storing more than the limit.
  // If the object that actually landed in R2 is bigger than allowed,
  // remove it immediately rather than leaving an oversized object
  // reachable by a later /versions call.
  if (obj.size > limit) {
    await env.BUILDS.delete(fileKey);
    return new Response(
      `Upload too large: stored object was ${obj.size} bytes, exceeding the ${limit}-byte limit`,
      { status: 413 }
    );
  }

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
  critical?: boolean;
  phased_rollout_interval?: number;
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
  const critical = body.critical ? 1 : 0;
  const phasedRolloutInterval = body.phased_rollout_interval;

  if (!version || !file_key || !file_size || !sha256 || !signature) {
    return new Response(
      "Missing required fields: version, file_key, file_size, sha256, signature",
      { status: 400 }
    );
  }

  let explicitBuild: number | null = null;
  if (build_number !== undefined && build_number !== null) {
    if (!Number.isInteger(build_number) || build_number <= 0) {
      return new Response("build_number must be a positive integer, or omitted entirely", {
        status: 400,
      });
    }
    explicitBuild = build_number;
  }

  if (!SHA256_HEX_RE.test(sha256)) {
    return new Response("sha256 must be 64 hex characters", { status: 400 });
  }

  if (
    phasedRolloutInterval !== undefined &&
    (!Number.isFinite(phasedRolloutInterval) || phasedRolloutInterval < 0)
  ) {
    return new Response("phased_rollout_interval must be a non-negative number of seconds", {
      status: 400,
    });
  }

  if (!file_key.startsWith(`${appId}/`)) {
    return new Response("file_key does not belong to this app", { status: 400 });
  }
  const head = await env.BUILDS.head(file_key);
  if (!head) {
    return new Response("file_key not found in storage — upload first", { status: 400 });
  }

  // The single real integrity check: not "does the client's sha256 look
  // right", but "does it match what R2 itself verified while storing the
  // bytes". head.checksums.sha256 only exists because handleUpload passed
  // sha256 as a put() option — if it's missing, either an old CLI skipped
  // that header, or something wrote to this key outside our upload path.
  // Either way we can't vouch for the file, so refuse rather than trust
  // the client's claim at face value.
  if (!head.checksums.sha256) {
    return new Response(
      "No verified checksum on file — re-upload via the current CLI (upload must set X-Sha256)",
      { status: 400 }
    );
  }
  if (bufferToHex(head.checksums.sha256) !== sha256.toLowerCase()) {
    return new Response("sha256 does not match the uploaded file's verified checksum", {
      status: 400,
    });
  }

  // file_size is just a number the client puts in the JSON body — nothing
  // upstream of this ties it to the bytes actually in R2 (unlike sha256,
  // which we just checked against R2's own verified checksum above). A
  // wrong or malicious file_size would flow straight into the appcast's
  // <enclosure length="..."> attribute, which Sparkle-family updaters use
  // for content-length validation and progress display — so anchor it to
  // what R2 actually stored instead of trusting the client's claim.
  if (file_size !== head.size) {
    return new Response(
      `file_size (${file_size}) does not match the uploaded file's actual size in storage (${head.size})`,
      { status: 400 }
    );
  }

  // Sparkle (and most updaters) trust build_number as a strictly increasing
  // ordering — publishing one that's <= the current latest on this channel
  // would either silently vanish (fine) or, worse, get treated as "newer"
  // by a client that's confused about ordering. Enforce it server-side
  // rather than trusting the CLI/build script to always get it right.
  // Only relevant when the caller passed an explicit number — if they
  // didn't, the INSERT below computes the next one itself, atomically.
  if (explicitBuild !== null) {
    const latest = await env.DB.prepare(
      `SELECT MAX(build_number) as max_build FROM versions WHERE app_id = ? AND channel = ?`
    )
      .bind(appId, channel)
      .first<{ max_build: number | null }>();

    if (latest?.max_build != null && explicitBuild <= latest.max_build) {
      return new Response(
        `build_number ${explicitBuild} is not greater than the current latest (${latest.max_build}) on channel "${channel}"`,
        { status: 409 }
      );
    }
  }

  const createdAt = Math.floor(Date.now() / 1000);

  // COALESCE(?, ...) picks the explicit build number when given, or computes
  // "current max on this channel + 1" (1 if there isn't one yet) in the same
  // statement — a single INSERT is atomic in SQLite, so this can't race with
  // a concurrent publish the way a separate SELECT-then-INSERT could.
  const inserted = await env.DB.prepare(
    `INSERT INTO versions
      (app_id, channel, version, build_number, file_key, file_size, sha256, signature, release_notes, critical, phased_rollout_interval, created_at)
     SELECT ?, ?, ?,
       COALESCE(?, (SELECT COALESCE(MAX(build_number), 0) FROM versions WHERE app_id = ? AND channel = ?) + 1),
       ?, ?, ?, ?, ?, ?, ?, ?
     RETURNING id, build_number`
  )
    .bind(
      appId,
      channel,
      version,
      explicitBuild,
      appId,
      channel,
      file_key,
      file_size,
      sha256,
      signature,
      release_notes ?? null,
      critical,
      phasedRolloutInterval ?? null,
      createdAt
    )
    .first<{ id: number; build_number: number }>();

  const finalBuildNumber = inserted!.build_number;

  return new Response(
    JSON.stringify({
      id: inserted!.id,
      app_id: appId,
      channel,
      version,
      build_number: finalBuildNumber,
      file_key,
      appcast_url: `/${appId}/appcast.xml?channel=${encodeURIComponent(channel)}`,
    }),
    { status: 201, headers: { "Content-Type": "application/json" } }
  );
}

interface ReleaseRow {
  id: number;
  channel: string;
  version: string;
  build_number: number;
  file_key: string;
  file_size: number;
  sha256: string;
  release_notes: string | null;
  critical: number;
  phased_rollout_interval: number | null;
  created_at: number;
}

// Powers both the dashboard and `railcast list` in the CLI. Read-only, so
// either a "read" or "publish" scoped token can call it (requireAppOwnership
// defaults to requiring "publish" — pass "read" explicitly here).
async function handleListReleases(request: Request, env: Env, appId: string): Promise<Response> {
  const auth = await requireAppOwnership(request, env, appId, "read");
  if (!auth.ok) return auth.response;

  const appRow = await env.DB.prepare(`SELECT name FROM apps WHERE id = ?`)
    .bind(appId)
    .first<{ name: string }>();

  // Newest-first within each channel, channel grouped together — this is
  // the order `railcast list` renders in, and a reasonable default for the
  // dashboard too. Signature/file_key are omitted: they're either huge
  // (signature is base64 of a full EdDSA sig, of no interest for a listing)
  // or purely internal (file_key), not something a CLI table needs.
  const { results } = await env.DB.prepare(
    `SELECT id, channel, version, build_number, file_key, file_size, sha256,
            release_notes, critical, phased_rollout_interval, created_at
     FROM versions
     WHERE app_id = ?
     ORDER BY channel ASC, build_number DESC`
  )
    .bind(appId)
    .all<ReleaseRow>();

  return jsonResponse({
    app_id: appId,
    app_name: appRow?.name ?? null,
    history_limit: APPCAST_HISTORY_LIMIT,
    releases: results ?? [],
  });
}

// Deletes a single release: the DB row, and — if no other release still
// points at the same file_key (shouldn't happen given upload's
// already-published check, but cheap to confirm rather than assume) — the
// underlying R2 object too, so a deleted release doesn't leave storage
// silently billing forever.
async function handleDeleteRelease(
  request: Request,
  env: Env,
  appId: string,
  releaseId: string
): Promise<Response> {
  const auth = await requireAppOwnership(request, env, appId, "publish");
  if (!auth.ok) return auth.response;

  const id = Number(releaseId);
  if (!Number.isInteger(id) || id <= 0) {
    return jsonResponse({ error: "invalid_input", message: "release id must be a positive integer" }, 400);
  }

  const release = await env.DB.prepare(
    `SELECT file_key, channel FROM versions WHERE id = ? AND app_id = ?`
  )
    .bind(id, appId)
    .first<{ file_key: string; channel: string }>();

  if (!release) {
    return jsonResponse({ error: "not_found" }, 404);
  }

  // Refuse to delete a channel's only remaining release — leaving an
  // active app with zero entries on a channel silently breaks the
  // appcast feed for anyone still on that channel, with no way back
  // short of publishing a brand new build. The "> 1" check happens
  // inside the DELETE's own WHERE clause (a correlated subquery over the
  // same table) rather than as a separate SELECT beforehand, so it's
  // atomic: two concurrent deletes racing to empty a 2-release channel
  // can't both succeed, because SQLite serializes writes to the table and
  // the second DELETE's subquery re-evaluates against the post-first-delete
  // count.
  const result = await env.DB.prepare(
    `DELETE FROM versions
     WHERE id = ? AND app_id = ?
       AND (SELECT COUNT(*) FROM versions v2 WHERE v2.app_id = versions.app_id AND v2.channel = versions.channel) > 1`
  )
    .bind(id, appId)
    .run();

  if (result.meta.changes === 0) {
    return jsonResponse(
      {
        error: "conflict",
        message: `Cannot delete the only release on channel '${release.channel}' — delete the app itself if you want to remove it entirely.`,
      },
      409
    );
  }

  const stillReferenced = await env.DB.prepare(
    `SELECT 1 FROM versions WHERE file_key = ? LIMIT 1`
  )
    .bind(release.file_key)
    .first();

  if (!stillReferenced) {
    // Best-effort: the DB row is already gone either way, which is the
    // part that actually matters for appcast.xml and for the immutable
    // file_key check on future uploads. If R2 cleanup fails, the object
    // just becomes storage we're paying for but nothing points at — worth
    // fixing but not worth failing the whole delete over.
    await env.BUILDS.delete(release.file_key).catch(() => {});
  }

  return new Response(null, { status: 204 });
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
    if (!appRow || !appRow.beta_token || suppliedToken !== appRow.beta_token) {
      // Same 404 as "not found" — don't reveal whether the app/channel
      // exists to someone without the token.
      return new Response("Not found", { status: 404 });
    }
  }

  const { results } = await env.DB.prepare(
    `SELECT version, build_number, file_key, file_size, sha256, signature, release_notes, critical, phased_rollout_interval, created_at
     FROM versions
     WHERE app_id = ? AND channel = ?
     ORDER BY build_number DESC
     LIMIT ?`
  )
    .bind(appId, channel, APPCAST_HISTORY_LIMIT)
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

    // Redirect a logged-in visitor straight to /dashboard before any landing
    // HTML goes out, instead of shipping the marketing page and bouncing
    // client-side after the fact (that flash-then-jump is what we're
    // avoiding). Anonymous visitors fall straight through to the static
    // asset with no extra DB round trip cost on their path.
    if (url.pathname === "/" && request.method === "GET") {
      const user = await getSessionUser(request, env);
      if (user) {
        return new Response(null, { status: 302, headers: { Location: "/dashboard" } });
      }
      return env.ASSETS.fetch(request);
    }

    if (url.pathname === "/logout" && request.method === "GET") {
      return handleLogout();
    }
    if (url.pathname === "/auth/request" && request.method === "POST") {
      return handleAuthRequest(request, env);
    }
    if (url.pathname === "/auth/verify" && request.method === "GET") {
      return handleAuthVerify(request, env);
    }
    if (url.pathname === "/auth/register" && request.method === "POST") {
      return handleAuthRegister(request, env);
    }
    if (url.pathname === "/auth/verify-email" && request.method === "GET") {
      return handleVerifyEmail(request, env);
    }
    if (url.pathname === "/auth/login" && request.method === "POST") {
      return handleAuthLogin(request, env);
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

    const releasesListMatch = url.pathname.match(/^\/([a-zA-Z0-9_-]+)\/releases$/);
    if (releasesListMatch && request.method === "GET") {
      const [, appId] = releasesListMatch;
      return handleListReleases(request, env, appId);
    }

    const releaseDeleteMatch = url.pathname.match(/^\/([a-zA-Z0-9_-]+)\/releases\/([a-zA-Z0-9_-]+)$/);
    if (releaseDeleteMatch && request.method === "DELETE") {
      const [, appId, releaseId] = releaseDeleteMatch;
      return handleDeleteRelease(request, env, appId, releaseId);
    }

    return new Response("Railcast API is alive", { status: 200 });
  },
};
