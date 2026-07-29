import { getUserFromRequest, json, publicUser } from "../../_lib/core.js";

export async function onRequestGet(context) {
  const db = context.env.DB;
  if (!db) return json({ user: null, error: "Database not configured" }, 503);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ user: null }, 401);
  return json({ user: publicUser(user) });
}
