import { getUserFromRequest } from "./core.js";

/**
 * Plan-gating middleware.
 * Returns 403 JSON with upgrade CTA when user's plan_slug doesn't match any allowed slug.
 * Usage: const denied = await requirePlan(request, env, ['family_monthly','family_yearly']);
 *        if (denied) return denied;
 */
export async function requirePlan(request, env, allowedSlugs = []) {
  const user = await getUserFromRequest(env.DB, request);
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  const slug = user.plan_slug || "";
  if (allowedSlugs.length && !allowedSlugs.some((s) => slug.startsWith(s))) {
    return new Response(
      JSON.stringify({
        error: "plan_required",
        message: "This feature requires an upgraded plan.",
        required: allowedSlugs,
        current: slug || null,
      }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  }
  request._user = user;
  return null;
}

/** Resolve user's team (first active team membership). Attaches team to request. */
export async function resolveTeam(request, env) {
  const user = request._user;
  if (!user) return null;
  const db = env.DB;
  const row = await db
    .prepare(
      "SELECT t.* FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE tm.user_id = ? AND tm.status = 'active' LIMIT 1",
    )
    .bind(user.id)
    .first();
  if (row) request._team = row;
  return row;
}
