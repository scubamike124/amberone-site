import { ensureSchema, getUserFromRequest, json, nowIso, originFrom, uid } from "../_lib/core.js";
import {
  exchangeGoogleCode,
  googleAuthUrl,
  googleOAuthRedirectUri,
  googleUserEmail,
  isGoogleCalendarOAuthConfigured,
} from "../_lib/google-calendar.js";

const TOOLKIT = "googlecalendar";

function htmlRedirect(location) {
  return new Response(null, {
    status: 302,
    headers: { Location: location, "Cache-Control": "no-store" },
  });
}

export async function onRequestGet(context) {
  const env = context.env;
  const db = env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);

  if (!isGoogleCalendarOAuthConfigured(env)) {
    return json(
      {
        error:
          "Google Calendar OAuth is not configured on this site yet. Client ID and secret are in Amber Vault and still need to be pushed to the website.",
      },
      503,
    );
  }

  const url = new URL(context.request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const redirectUri = googleOAuthRedirectUri(context.request);
  const origin = originFrom(context.request);

  if (error) {
    return htmlRedirect(`${origin}/dashboard/connections?connected=${TOOLKIT}&error=${encodeURIComponent(error)}`);
  }

  if (!code) {
    const user = await getUserFromRequest(db, context.request);
    if (!user) {
      return htmlRedirect(`${origin}/login?next=/dashboard/connections`);
    }
    const nonce = uid("gcal");
    const ts = nowIso();
    const existing = await db
      .prepare(
        "SELECT id FROM connected_accounts WHERE user_id = ? AND toolkit = ? ORDER BY updated_at DESC LIMIT 1",
      )
      .bind(user.id, TOOLKIT)
      .first();
    if (existing) {
      await db
        .prepare(
          "UPDATE connected_accounts SET status = 'pending', metadata_json = ?, updated_at = ? WHERE id = ?",
        )
        .bind(JSON.stringify({ oauthState: nonce }), ts, existing.id)
        .run();
    } else {
      await db
        .prepare(
          `INSERT INTO connected_accounts (id, user_id, provider, toolkit, status, composio_connected_account_id, auth_config_id, metadata_json, created_at, updated_at)
           VALUES (?, ?, 'google', ?, 'pending', NULL, NULL, ?, ?, ?)`,
        )
        .bind(uid("conn"), user.id, TOOLKIT, JSON.stringify({ oauthState: nonce }), ts, ts)
        .run();
    }
    return htmlRedirect(
      googleAuthUrl({
        clientId: env.GOOGLE_CALENDAR_CLIENT_ID,
        redirectUri,
        state: nonce,
      }),
    );
  }

  if (!state) {
    return htmlRedirect(`${origin}/dashboard/connections?connected=${TOOLKIT}&error=missing_state`);
  }

  const pending = await db
    .prepare(
      `SELECT id, user_id, metadata_json FROM connected_accounts
       WHERE toolkit = ? AND metadata_json LIKE ?
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .bind(TOOLKIT, `%"oauthState":"${state}"%`)
    .first();
  if (!pending) {
    return htmlRedirect(`${origin}/dashboard/connections?connected=${TOOLKIT}&error=unknown_state`);
  }

  try {
    const tokens = await exchangeGoogleCode(env, { code, redirectUri });
    const email = tokens.access_token ? await googleUserEmail(tokens.access_token) : null;
    const meta = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || null,
      token_type: tokens.token_type || "Bearer",
      expiry: Date.now() + Number(tokens.expires_in || 3600) * 1000,
      google_email: email,
      native: true,
    };
    await db
      .prepare("UPDATE connected_accounts SET status = 'ACTIVE', metadata_json = ?, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(meta), nowIso(), pending.id)
      .run();
  } catch (err) {
    const message = err instanceof Error ? err.message : "token_exchange_failed";
    return htmlRedirect(
      `${origin}/dashboard/connections?connected=${TOOLKIT}&error=${encodeURIComponent(message.slice(0, 120))}`,
    );
  }

  return htmlRedirect(`${origin}/dashboard/connections?connected=${TOOLKIT}`);
}
