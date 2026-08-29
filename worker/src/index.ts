export interface Env {
  DB: D1Database;
  BUILDS: R2Bucket;
  PUBLIC_FILE_BASE_URL: string;
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

  const tokenRow = await env.DB.prepare(
    `SELECT user_id FROM api_tokens WHERE token = ?`
  )
    .bind(token)
    .first<{ user_id: string }>();

  if (!tokenRow) {
    return new Response("Unauthorized", { status: 401 });
  }

  const appRow = await env.DB.prepare(
    `SELECT owner_user_id FROM apps WHERE id = ?`
  )
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

  return new Response(
    JSON.stringify({ file_key: fileKey, file_size: obj?.size ?? null }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
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

  const tokenRow = await env.DB.prepare(
    `SELECT user_id FROM api_tokens WHERE token = ?`
  )
    .bind(token)
    .first<{ user_id: string }>();

  if (!tokenRow) {
    return { ok: false, response: new Response("Unauthorized", { status: 401 }) };
  }

  const appRow = await env.DB.prepare(
    `SELECT owner_user_id FROM apps WHERE id = ?`
  )
    .bind(appId)
    .first<{ owner_user_id: string }>();

  if (!appRow || appRow.owner_user_id !== tokenRow.user_id) {
    return { ok: false, response: new Response("Forbidden", { status: 403 }) };
  }

  return { ok: true };
}

async function handleCreateVersion(
  request: Request,
  env: Env,
  appId: string
): Promise<Response> {
  const auth = await requireAppOwnership(request, env, appId);
  if (!auth.ok) return auth.response;

  let body: CreateVersionBody;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const {
    version,
    build_number,
    file_key,
    file_size,
    sha256,
    signature,
    release_notes,
  } = body;
  const channel = body.channel ?? "stable";

  if (
    !version ||
    !build_number ||
    !file_key ||
    !file_size ||
    !sha256 ||
    !signature
  ) {
    return new Response(
      "Missing required fields: version, build_number, file_key, file_size, sha256, signature",
      { status: 400 }
    );
  }

  // Make sure the referenced object actually exists in this app's namespace
  // before we register a version pointing at it.
  if (!file_key.startsWith(`${appId}/`)) {
    return new Response("file_key does not belong to this app", { status: 400 });
  }
  const head = await env.BUILDS.head(file_key);
  if (!head) {
    return new Response("file_key not found in storage — upload first", {
      status: 400,
    });
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const uploadMatch = url.pathname.match(
      /^\/([a-zA-Z0-9_-]+)\/upload\/([a-zA-Z0-9_.\-]+)$/
    );
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
