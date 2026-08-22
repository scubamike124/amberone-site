import { ensureSchema } from "../../_lib/core.js";

export async function onRequestGet(context) {
  const db = context.env.DB;
  const r2 = context.env.MEDIA_BUCKET || context.env.R2;
  if (!db || !r2) return new Response("Not found", { status: 404 });
  await ensureSchema(db);
  const file = context.params?.file || "";
  const match = String(file).match(/^(spost_[a-z0-9]+)--([A-Za-z0-9_-]+)\.png$/i);
  if (!match) return new Response("Not found", { status: 404 });
  const id = match[1];
  const token = match[2];
  const row = await db.prepare("SELECT id, user_id, image_token FROM social_posts WHERE id = ?").bind(id).first();
  if (!row || row.image_token !== token) return new Response("Not found", { status: 404 });
  const obj = await r2.get(`amberone/social/${row.user_id}/${row.id}.png`);
  if (!obj) return new Response("Not found", { status: 404 });
  return new Response(await obj.arrayBuffer(), {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
