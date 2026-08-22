import { ensureSchema, getUserFromRequest, json, nowIso, originFrom, uid } from "../_lib/core.js";
import {
  exchangeNextdoorCode,
  fetchNextdoorProfiles,
  isNextdoorOAuthConfigured,
  nextdoorAuthUrl,
  nextdoorOAuthRedirectUri,
  pickNextdoorProfile,
} from "../_lib/nextdoor.js";

const TOOLKIT = "nextdoor";

function htmlRedirect(location) {
  return new Response(null, {
    status: 302,
    headers: { Location: location, "Cache-Control": "no-store" },
  });
}

function parseMeta(row) {
  try {
    return JSON.parse(row?.metadata_json || "{}") || {};
  } catch {
    return {};
  }
}

export async function onRequestGet(context) {
  const env = context.env;
  const db = env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);

  if (!isNextdoorOAuthConfigured(env)) {
    return json(
      {
        error:
          "Nextdoor publishing is not configured on Amber One yet. Amber needs a Nextdoor Publish API client id and secret from Nextdoor’s partner program.",
        code: "nextdoor_not_configured",
      },
      503,
    );
  }

  const url = new URL(context.request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const redirectUri = nextdoorOAuthRedirectUri(context.request);
  const origin = originFrom(context.request);
  const done = `${origin}/dashboard/business/marketing.html?connected=${TOOLKIT}`;

  if (error) {
    return htmlRedirect(`${done}&error=${encodeURIComponent(error)}`);
  }

  if (!code) {
    const user = await getUserFromRequest(db, context.request);
    if (!user) return htmlRedirect(`${origin}/login?next=/dashboard/business/marketing.html`);
    const nonce = uid("nd");
    const ts = nowIso();
    const existing = await db
      .prepare("SELECT id FROM connected_accounts WHERE user_id = ? AND toolkit = ? ORDER BY updated_at DESC LIMIT 1")
      .bind(user.id, TOOLKIT)
      .first();
    if (existing) {
      await db
        .prepare("UPDATE connected_accounts SET status = 'pending', metadata_json = ?, updated_at = ? WHERE id = ?")
        .bind(JSON.stringify({ oauthState: nonce }), ts, existing.id)
        .run();
    } else {
      await db
        .prepare(
          `INSERT INTO connected_accounts (id, user_id, provider, toolkit, status, composio_connected_account_id, auth_config_id, metadata_json, created_at, updated_at)
           VALUES (?, ?, 'nextdoor', ?, 'pending', NULL, NULL, ?, ?, ?)`,
        )
        .bind(uid("conn"), user.id, TOOLKIT, JSON.stringify({ oauthState: nonce }), ts, ts)
        .run();
    }
    return htmlRedirect(
      nextdoorAuthUrl({
        clientId: env.NEXTDOOR_CLIENT_ID,
        redirectUri,
        state: nonce,
      }),
    );
  }

  const pending = await db
    .prepare(
      `SELECT id, user_id, metadata_json FROM connected_accounts
       WHERE toolkit = ? AND status IN ('pending', 'INITIATED', 'INITIALIZING')
       ORDER BY updated_at DESC LIMIT 20`,
    )
    .bind(TOOLKIT)
    .all();
  const row = (pending.results || []).find((r) => parseMeta(r).oauthState === state);
  if (!row) {
    return htmlRedirect(`${done}&error=${encodeURIComponent("Nextdoor login did not match a pending connect.")}`);
  }

  try {
    const tokens = await exchangeNextdoorCode(env, { code, redirectUri });
    const profiles = await fetchNextdoorProfiles(tokens.access_token);
    const profile = pickNextdoorProfile(profiles);
    const meta = {
      token_type: tokens.token_type || "Bearer",
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || null,
      expiry: Date.now() + Number(tokens.expires_in || 3600) * 1000,
      profile_id: profile?.profileId || null,
      profile_name: profile?.name || null,
      is_business: Boolean(profile?.isBusiness),
    };
    await db
      .prepare("UPDATE connected_accounts SET status = 'ACTIVE', metadata_json = ?, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(meta), nowIso(), row.id)
      .run();
    return htmlRedirect(`${done}&ok=1`);
  } catch (err) {
    await db
      .prepare("UPDATE connected_accounts SET status = 'failed', updated_at = ? WHERE id = ?")
      .bind(nowIso(), row.id)
      .run();
    return htmlRedirect(`${done}&error=${encodeURIComponent(err instanceof Error ? err.message : "Nextdoor connect failed")}`);
  }
}
