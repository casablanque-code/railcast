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

function renderAppcast(appId: string, rows: VersionRow[], fileBaseUrl: string): string {
  const items = rows
    .map((r) => {
      const pubDate = new Date(r.created_at * 1000).toUTCString();
      const downloadUrl = `${fileBaseUrl}/${r.file_key}`;
      return `    <item>
      <title>Version ${escapeXml(r.version)}</title>
      <pubDate>${pubDate}</pubDate>
      <sparkle:version>${r.build_number}</sparkle:version>
      <sparkle:shortVersionString>${escapeXml(r.version)}</sparkle:shortVersionString>
      <description><![CDATA[${r.release_notes ?? ""}]]></description>
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
${items}
  </channel>
</rss>`;
}

// ---------- Auth helpers ----------

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

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

  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `SELECT users.id as id, users.email as email
     FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.id = ? AND sessions.expires_at > ?`
  )
    .bind(sessionId, now)
    .first<{ id: string; email: string }>();

  return row ?? null;
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
      subject: "Войти в Railcast",
      html: `<p>Нажми, чтобы войти:</p><p><a href="${link}">${link}</a></p><p>Ссылка действует 15 минут.</p>`,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Resend API error (${resp.status}): ${text}`);
  }
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

  const token = randomToken();
  const expiresAt = Math.floor(Date.now() / 1000) + 15 * 60;

  await env.DB.prepare(
    `INSERT INTO magic_links (token, email, expires_at, used) VALUES (?, ?, ?, 0)`
  )
    .bind(token, email, expiresAt)
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

  const linkRow = await env.DB.prepare(
    `SELECT email, expires_at, used FROM magic_links WHERE token = ?`
  )
    .bind(token)
    .first<{ email: string; expires_at: number; used: number }>();

  const now = Math.floor(Date.now() / 1000);
  if (!linkRow || linkRow.used || linkRow.expires_at < now) {
    return new Response("Invalid or expired link", { status: 400 });
  }

  await env.DB.prepare(`UPDATE magic_links SET used = 1 WHERE token = ?`).bind(token).run();

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
  const sessionExpiresAt = now + 30 * 24 * 60 * 60;

  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`
  )
    .bind(sessionId, user.id, sessionExpiresAt, now)
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
      Location: "/login",
      "Set-Cookie": "session=; Path=/; HttpOnly; Max-Age=0",
    },
  });
}

// ---------- Dashboard HTML ----------

function htmlPage(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <title>${escapeXml(title)}</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 16px; color: #1a1a1a; }
    h1 { font-size: 20px; }
    table { width: 100%; border-collapse: collapse; margin: 16px 0; }
    th, td { text-align: left; padding: 8px; border-bottom: 1px solid #eee; font-size: 14px; }
    code { background: #f4f4f4; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
    input, button { font-size: 14px; padding: 8px; }
    .muted { color: #777; font-size: 13px; }
    a { color: #2563eb; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

function handleLoginPage(): Response {
  const body = `
    <h1>Войти в Railcast</h1>
    <form id="f">
      <input name="email" type="email" placeholder="you@example.com" required />
      <button type="submit">Прислать ссылку для входа</button>
    </form>
    <p id="msg" class="muted"></p>
    <script>
      document.getElementById('f').addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = e.target.email.value;
        document.getElementById('msg').textContent = 'Отправляю...';
        const resp = await fetch('/auth/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        const data = await resp.json();
        document.getElementById('msg').textContent = resp.ok
          ? 'Проверь почту — прислали ссылку для входа.'
          : 'Ошибка: ' + (data.message || resp.status);
      });
    </script>
  `;
  return new Response(htmlPage("Войти — Railcast", body), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function handleDashboard(request: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(request, env);
  if (!user) {
    return new Response(null, { status: 302, headers: { Location: "/login" } });
  }

  const { results: apps } = await env.DB.prepare(
    `SELECT id, signing_public_key FROM apps WHERE owner_user_id = ?`
  )
    .bind(user.id)
    .all<{ id: string; signing_public_key: string }>();

  const { results: tokens } = await env.DB.prepare(
    `SELECT token, created_at FROM api_tokens WHERE user_id = ?`
  )
    .bind(user.id)
    .all<{ token: string; created_at: number }>();

  const url = new URL(request.url);
  const origin = url.origin;

  const appsHtml = (apps ?? [])
    .map(
      (a) => `<tr>
        <td><code>${escapeXml(a.id)}</code></td>
        <td><a href="${origin}/${escapeXml(a.id)}/appcast.xml" target="_blank">${origin}/${escapeXml(
        a.id
      )}/appcast.xml</a></td>
      </tr>`
    )
    .join("");

  const tokensHtml = (tokens ?? [])
    .map((t) => `<tr><td><code>${escapeXml(t.token)}</code></td></tr>`)
    .join("");

  const body = `
    <h1>Railcast — ${escapeXml(user.email)}</h1>
    <p class="muted"><a href="/logout">Выйти</a></p>

    <h2>Твои приложения</h2>
    <table>
      <tr><th>App ID</th><th>Feed URL</th></tr>
      ${appsHtml || '<tr><td colspan="2" class="muted">Пока нет приложений</td></tr>'}
    </table>

    <form method="POST" action="/apps">
      <input name="app_id" placeholder="app-id (латиница, цифры, дефис)" required />
      <input name="public_key" placeholder="публичный ключ (из railcast keygen)" required style="width:340px" />
      <button type="submit">Создать приложение</button>
    </form>

    <h2>API-токены (для CLI)</h2>
    <table>
      <tr><th>Токен</th></tr>
      ${tokensHtml || '<tr><td class="muted">Пока нет токенов</td></tr>'}
    </table>

    <form method="POST" action="/tokens">
      <button type="submit">Сгенерировать новый токен</button>
    </form>
  `;

  return new Response(htmlPage("Railcast Dashboard", body), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function handleCreateApp(request: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(request, env);
  if (!user) return new Response(null, { status: 302, headers: { Location: "/login" } });

  const form = await request.formData();
  const appId = String(form.get("app_id") ?? "").trim();
  const publicKey = String(form.get("public_key") ?? "").trim();

  if (!/^[a-zA-Z0-9_-]+$/.test(appId) || !publicKey) {
    return new Response("Invalid app_id or public_key", { status: 400 });
  }

  await env.DB.prepare(
    `INSERT INTO apps (id, owner_email, owner_user_id, signing_public_key, created_at)
     VALUES (?, ?, ?, ?, unixepoch())`
  )
    .bind(appId, user.email, user.id, publicKey)
    .run();

  return new Response(null, { status: 302, headers: { Location: "/dashboard" } });
}

async function handleCreateToken(request: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(request, env);
  if (!user) return new Response(null, { status: 302, headers: { Location: "/login" } });

  const token = randomToken();
  await env.DB.prepare(
    `INSERT INTO api_tokens (token, user_id, created_at) VALUES (?, ?, unixepoch())`
  )
    .bind(token, user.id)
    .run();

  return new Response(null, { status: 302, headers: { Location: "/dashboard" } });
}

// ---------- Upload / versions / appcast (CLI-facing API) ----------

async function handleUpload(
  request: Request,
  env: Env,
  appId: string,
  filename: string
): Promise<Response> {
  const authHeader = request.headers.get("Authorization") ?? "";
  const token = authHeader.replace("Bearer ", "");
  if (!token) {
    return new Response("Unauthorized", { status: 401 });
  }

  const tokenRow = await env.DB.prepare(`SELECT user_id FROM api_tokens WHERE token = ?`)
    .bind(token)
    .first<{ user_id: string }>();

  if (!tokenRow) {
    return new Response("Unauthorized", { status: 401 });
  }

  const appRow = await env.DB.prepare(`SELECT owner_user_id FROM apps WHERE id = ?`)
    .bind(appId)
    .first<{ owner_user_id: string }>();

  if (!appRow || appRow.owner_user_id !== tokenRow.user_id) {
    return new Response("Forbidden", { status: 403 });
  }

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

async function requireAppOwnership(
  request: Request,
  env: Env,
  appId: string
): Promise<{ ok: true } | { ok: false; response: Response }> {
  const authHeader = request.headers.get("Authorization") ?? "";
  const token = authHeader.replace("Bearer ", "");
  if (!token) {
    return { ok: false, response: new Response("Unauthorized", { status: 401 }) };
  }

  const tokenRow = await env.DB.prepare(`SELECT user_id FROM api_tokens WHERE token = ?`)
    .bind(token)
    .first<{ user_id: string }>();

  if (!tokenRow) {
    return { ok: false, response: new Response("Unauthorized", { status: 401 }) };
  }

  const appRow = await env.DB.prepare(`SELECT owner_user_id FROM apps WHERE id = ?`)
    .bind(appId)
    .first<{ owner_user_id: string }>();

  if (!appRow || appRow.owner_user_id !== tokenRow.user_id) {
    return { ok: false, response: new Response("Forbidden", { status: 403 }) };
  }

  return { ok: true };
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

  const xml = renderAppcast(appId, results, env.PUBLIC_FILE_BASE_URL);

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

    if (url.pathname === "/login" && request.method === "GET") {
      return handleLoginPage();
    }
    if (url.pathname === "/dashboard" && request.method === "GET") {
      return handleDashboard(request, env);
    }
    if (url.pathname === "/apps" && request.method === "POST") {
      return handleCreateApp(request, env);
    }
    if (url.pathname === "/tokens" && request.method === "POST") {
      return handleCreateToken(request, env);
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
