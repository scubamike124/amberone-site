import { ensureSchema } from "../_lib/core.js";

export async function onRequestGet(context) {
  const db = context.env.DB;
  const r2 = context.env.MEDIA_BUCKET || context.env.R2;
  if (!db || !r2) return new Response("Not found", { status: 404 });
  await ensureSchema(db);
  const url = new URL(context.request.url);
  const id = url.searchParams.get("id");
  const token = url.searchParams.get("t");
  if (!id || !token) return new Response("Not found", { status: 404 });
  const row = await db.prepare("SELECT id, user_id, image_token FROM social_posts WHERE id = ?").bind(id).first();
  if (!row || row.image_token !== token) return new Response("Not found", { status: 404 });
  const obj = await r2.get(`amberone/social/${row.user_id}/${row.id}.png`);
  if (!obj) return new Response("Not found", { status: 404 });
  const bytes = await obj.arrayBuffer();
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "image/png",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
