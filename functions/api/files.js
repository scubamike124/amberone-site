import {
  ensureSchema,
  getUserFromRequest,
  json,
  nowIso,
  readJson,
  uid,
  writeAudit,
} from "../_lib/core.js";

const MAX_BYTES = 10 * 1024 * 1024;
const KEY_PREFIX = "amberone/";
const ALLOWED_TYPES = new Set([
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/json",
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const ALLOWED_EXT = new Set([
  "txt",
  "csv",
  "md",
  "json",
  "pdf",
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "doc",
  "docx",
]);

function bucket(env) {
  return env.MEDIA_BUCKET || env.R2 || null;
}

function extOf(name) {
  const parts = String(name || "").toLowerCase().split(".");
  return parts.length > 1 ? parts.pop() : "";
}

function safeName(name) {
  const base = String(name || "file")
    .replace(/[/\\]/g, "")
    .replace(/[^\w.\- ()]+/g, "_")
    .slice(0, 120);
  return base || "file";
}

function contentTypeAllowed(name, contentType) {
  const ext = extOf(name);
  if (ext && !ALLOWED_EXT.has(ext)) return false;
  if (contentType && ALLOWED_TYPES.has(contentType.split(";")[0].trim().toLowerCase())) return true;
  if (!contentType && ALLOWED_EXT.has(ext)) return true;
  return false;
}

async function projectMember(db, projectId, user) {
  if (!projectId) return null;
  return db
    .prepare(
      `SELECT * FROM project_members
       WHERE project_id = ? AND status = 'active'
         AND (user_id = ? OR lower(invited_email) = lower(?))
       LIMIT 1`,
    )
    .bind(projectId, user.id, user.email)
    .first();
}

async function access(db, user, file) {
  if (!file) return { read: false, write: false };
  if (file.user_id === user.id) return { read: true, write: true };
  if (!file.project_id) return { read: false, write: false };
  const member = await projectMember(db, file.project_id, user);
  if (!member) return { read: false, write: false };
  if (member.role === "viewer") return { read: true, write: false };
  return { read: true, write: true };
}

function publicFile(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    content_type: row.content_type,
    size: row.size,
    project_id: row.project_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    url: `/api/files?id=${encodeURIComponent(row.id)}&download=1`,
  };
}

async function readUpload(request) {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") return { error: "file is required", status: 400 };
    const buf = new Uint8Array(await file.arrayBuffer());
    return {
      name: file.name || String(form.get("name") || "upload"),
      contentType: file.type || String(form.get("content_type") || "application/octet-stream"),
      body: buf,
      projectId: form.get("project_id") ? String(form.get("project_id")) : null,
      replaceId: form.get("id") ? String(form.get("id")) : null,
    };
  }
  const body = await readJson(request);
  const raw = body.content_base64 || body.contentBase64 || body.content;
  if (!raw) return { error: "file or content_base64 is required", status: 400 };
  let bytes;
  try {
    const bin = atob(String(raw).replace(/^data:[^;]+;base64,/, ""));
    bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return { error: "Invalid file encoding", status: 400 };
  }
  return {
    name: String(body.name || "upload"),
    contentType: String(body.content_type || body.contentType || "application/octet-stream"),
    body: bytes,
    projectId: body.project_id || body.projectId || null,
    replaceId: body.id || null,
  };
}

export async function onRequestGet(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const r2 = bucket(context.env);
  if (!r2) return json({ error: "File storage is not bound", code: "r2_unbound" }, 503);

  const url = new URL(context.request.url);
  const id = url.searchParams.get("id");
  if (id) {
    const file = await db.prepare("SELECT * FROM files WHERE id = ?").bind(id).first();
    const rights = await access(db, user, file);
    if (!file || !rights.read) return json({ error: "Not found" }, 404);
    if (url.searchParams.get("download") === "1") {
      const obj = await r2.get(file.r2_key);
      if (!obj) return json({ error: "File missing from storage" }, 404);
      const bytes = await obj.arrayBuffer();
      return new Response(bytes, {
        status: 200,
        headers: {
          "Content-Type": file.content_type || obj.httpMetadata?.contentType || "application/octet-stream",
          "Content-Disposition": `attachment; filename="${safeName(file.name)}"`,
          "Cache-Control": "private, no-store",
        },
      });
    }
    return json({ file: publicFile(file), available: true });
  }

  const projectId = url.searchParams.get("project_id");
  if (projectId) {
    const member = await projectMember(db, projectId, user);
    if (!member) return json({ error: "Not found" }, 404);
    const rows = await db
      .prepare(
        "SELECT id, user_id, project_id, name, content_type, size, created_at, updated_at FROM files WHERE project_id = ? ORDER BY created_at DESC LIMIT 200",
      )
      .bind(projectId)
      .all();
    return json({ files: (rows.results || []).map(publicFile), available: true });
  }

  const rows = await db
    .prepare(
      "SELECT id, user_id, project_id, name, content_type, size, created_at, updated_at FROM files WHERE user_id = ? ORDER BY created_at DESC LIMIT 200",
    )
    .bind(user.id)
    .all();
  return json({ files: (rows.results || []).map(publicFile), available: true });
}

async function writeFile(context, isReplace) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const r2 = bucket(context.env);
  if (!r2) return json({ error: "File storage is not bound", code: "r2_unbound" }, 503);

  const length = Number(context.request.headers.get("content-length") || 0);
  if (length > MAX_BYTES) {
    return json({ error: "File is too large. Maximum upload size is 10 MB.", code: "file_too_large" }, 413);
  }

  const upload = await readUpload(context.request);
  if (upload.error) return json({ error: upload.error }, upload.status);
  if (upload.body.byteLength > MAX_BYTES) {
    return json({ error: "File is too large. Maximum upload size is 10 MB.", code: "file_too_large" }, 413);
  }
  if (!contentTypeAllowed(upload.name, upload.contentType)) {
    return json({ error: "That file type is not allowed.", code: "file_type" }, 400);
  }

  let existing = null;
  const urlId = new URL(context.request.url).searchParams.get("id");
  const replaceId = upload.replaceId || urlId;
  if (isReplace || replaceId) {
    if (!replaceId) return json({ error: "id is required to replace a file" }, 400);
    existing = await db.prepare("SELECT * FROM files WHERE id = ?").bind(replaceId).first();
    const rights = await access(db, user, existing);
    if (!existing || !rights.write) return json({ error: "Not found" }, 404);
  }

  if (upload.projectId) {
    const member = await projectMember(db, upload.projectId, user);
    if (!member || member.role === "viewer") return json({ error: "Not found" }, 404);
  }

  const id = existing?.id || uid("file");
  const name = safeName(upload.name);
  const key = existing?.r2_key || `${KEY_PREFIX}users/${user.id}/${id}/${name}`;
  const ts = nowIso();
  await r2.put(key, upload.body, { httpMetadata: { contentType: upload.contentType } });

  if (existing) {
    await db
      .prepare(
        "UPDATE files SET name = ?, content_type = ?, size = ?, r2_key = ?, updated_at = ? WHERE id = ?",
      )
      .bind(name, upload.contentType, upload.body.byteLength, key, ts, id)
      .run();
    await writeAudit(db, { userId: user.id, action: "file.replace", resourceType: "file", resourceId: id });
  } else {
    await db
      .prepare(
        "INSERT INTO files (id, user_id, project_id, name, content_type, size, r2_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .bind(id, user.id, upload.projectId, name, upload.contentType, upload.body.byteLength, key, ts, ts)
      .run();
    await writeAudit(db, { userId: user.id, action: "file.create", resourceType: "file", resourceId: id });
  }

  const row = await db.prepare("SELECT * FROM files WHERE id = ?").bind(id).first();
  return json({ ok: true, file: publicFile(row), available: true }, existing ? 200 : 201);
}

export async function onRequestPost(context) {
  return writeFile(context, false);
}

export async function onRequestPut(context) {
  return writeFile(context, true);
}

export async function onRequestDelete(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const r2 = bucket(context.env);
  if (!r2) return json({ error: "File storage is not bound", code: "r2_unbound" }, 503);

  const id = new URL(context.request.url).searchParams.get("id");
  if (!id) return json({ error: "id is required" }, 400);
  const file = await db.prepare("SELECT * FROM files WHERE id = ?").bind(id).first();
  const rights = await access(db, user, file);
  if (!file || !rights.write) return json({ error: "Not found" }, 404);
  if (!String(file.r2_key || "").startsWith(KEY_PREFIX)) {
    return json({ error: "Refusing to delete a file outside AmberOne storage" }, 403);
  }
  await r2.delete(file.r2_key);
  await db.prepare("DELETE FROM files WHERE id = ?").bind(id).run();
  await writeAudit(db, { userId: user.id, action: "file.delete", resourceType: "file", resourceId: id });
  return json({ ok: true });
}
