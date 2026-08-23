import { ensureSchema, getUserFromRequest, json, nowIso, originFrom, uid } from "../_lib/core.js";
import {
  exchangeTikTokCode,
  fetchTikTokUserInfo,
  isTikTokOAuthConfigured,
  tiktokAuthUrl,
  tiktokOAuthRedirectUri,
} from "../_lib/tiktok.js";

const TOOLKIT = "tiktok";

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

  if (!isTikTokOAuthConfigured(env)) {
    return json(
      {
        error:
          "TikTok publishing is not configured on Amber One yet. Add TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET from the TikTok Developer app.",
        code: "tiktok_not_configured",
      },
      503,
    );
  }

  const url = new URL(context.request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const redirectUri = tiktokOAuthRedirectUri(context.request);
  const origin = originFrom(context.request);
  const done = `${origin}/dashboard/business/marketing.html?connected=${TOOLKIT}`;

  if (error) {
    return htmlRedirect(`${done}&error=${encodeURIComponent(error)}`);
  }

  if (!code) {
    const user = await getUserFromRequest(db, context.request);
    if (!user) return htmlRedirect(`${origin}/login?next=/dashboard/business/marketing.html`);
    const nonce = uid("tt");
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
           VALUES (?, ?, 'tiktok', ?, 'pending', NULL, NULL, ?, ?, ?)`,
        )
        .bind(uid("conn"), user.id, TOOLKIT, JSON.stringify({ oauthState: nonce }), ts, ts)
        .run();
    }
    return htmlRedirect(
      tiktokAuthUrl({
        clientKey: env.TIKTOK_CLIENT_KEY,
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
    return htmlRedirect(`${done}&error=${encodeURIComponent("TikTok login did not match a pending connect.")}`);
  }

  try {
    const tokens = await exchangeTikTokCode(env, { code, redirectUri });
    const profile = await fetchTikTokUserInfo(tokens.access_token).catch(() => null);
    const meta = {
      token_type: tokens.token_type || "Bearer",
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || null,
      expiry: Date.now() + Number(tokens.expires_in || 86400) * 1000,
      open_id: tokens.open_id || profile?.open_id || null,
      scope: tokens.scope || null,
      display_name: profile?.display_name || null,
      username: profile?.username || null,
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
    return htmlRedirect(`${done}&error=${encodeURIComponent(err instanceof Error ? err.message : "TikTok connect failed")}`);
  }
}
