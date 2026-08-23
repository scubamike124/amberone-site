import { nowIso, originFrom } from "./core.js";

const AUTH = "https://www.tiktok.com/v2/auth/authorize/";
const TOKEN = "https://open.tiktokapis.com/v2/oauth/token/";
const REVOKE = "https://open.tiktokapis.com/v2/oauth/revoke/";
const CREATOR_INFO = "https://open.tiktokapis.com/v2/post/publish/creator_info/query/";
const PHOTO_INIT = "https://open.tiktokapis.com/v2/post/publish/content/init/";
const STATUS = "https://open.tiktokapis.com/v2/post/publish/status/fetch/";
const USERINFO = "https://open.tiktokapis.com/v2/user/info/";
const SCOPES = "user.info.basic video.publish";

function parseJsonSafe(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

export function isTikTokOAuthConfigured(env) {
  return Boolean(env?.TIKTOK_CLIENT_KEY && env?.TIKTOK_CLIENT_SECRET);
}

export function tiktokOAuthRedirectUri(request) {
  return `${originFrom(request)}/api/tiktok-oauth`;
}

export function tiktokAuthUrl({ clientKey, redirectUri, state }) {
  const url = new URL(AUTH);
  url.searchParams.set("client_key", clientKey);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  return url.toString();
}

async function tokenRequest(env, body) {
  if (!isTikTokOAuthConfigured(env)) {
    throw Object.assign(new Error("TikTok publishing is not configured on Amber One yet."), {
      status: 503,
      code: "tiktok_not_configured",
    });
  }
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      client_key: env.TIKTOK_CLIENT_KEY,
      client_secret: env.TIKTOK_CLIENT_SECRET,
      ...body,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const err = new Error(data.error_description || data.error || `TikTok token exchange failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function exchangeTikTokCode(env, { code, redirectUri }) {
  return tokenRequest(env, {
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
}

export async function refreshTikTokAccessToken(env, refreshToken) {
  return tokenRequest(env, {
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
}

export async function revokeTikTokToken(env, accessToken) {
  if (!isTikTokOAuthConfigured(env) || !accessToken) return;
  await fetch(REVOKE, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: env.TIKTOK_CLIENT_KEY,
      client_secret: env.TIKTOK_CLIENT_SECRET,
      token: accessToken,
    }),
  }).catch(() => {});
}

export async function activeTikTok(db, userId) {
  return db
    .prepare(
      `SELECT id, status, metadata_json
       FROM connected_accounts
       WHERE user_id = ? AND toolkit = 'tiktok'
       ORDER BY CASE WHEN lower(status) = 'active' THEN 0 ELSE 1 END, updated_at DESC
       LIMIT 1`,
    )
    .bind(userId)
    .first();
}

export async function getTikTokAccessToken(env, db, connection) {
  const meta = parseJsonSafe(connection?.metadata_json);
  const expiry = Number(meta.expiry || 0);
  if (meta.access_token && (!expiry || Date.now() < expiry - 60_000)) {
    return { accessToken: meta.access_token, meta, connection };
  }
  if (!meta.refresh_token) {
    if (meta.access_token) return { accessToken: meta.access_token, meta, connection };
    return null;
  }
  const tokens = await refreshTikTokAccessToken(env, meta.refresh_token);
  const next = {
    ...meta,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || meta.refresh_token,
    token_type: tokens.token_type || meta.token_type,
    expiry: Date.now() + Number(tokens.expires_in || 86400) * 1000,
  };
  await db
    .prepare("UPDATE connected_accounts SET metadata_json = ?, status = 'ACTIVE', updated_at = ? WHERE id = ?")
    .bind(JSON.stringify(next), nowIso(), connection.id)
    .run();
  return { accessToken: next.access_token, meta: next, connection };
}

export async function fetchTikTokUserInfo(accessToken) {
  const url = new URL(USERINFO);
  url.searchParams.set("fields", "open_id,union_id,display_name,username");
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error?.code === "error") {
    const err = new Error(data.error?.message || `TikTok user info failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data.data?.user || null;
}

/**
 * privacy_level is creator- and audit-status-specific — TikTok 403s if you
 * send a value that isn't in that creator's own privacy_level_options
 * (unaudited apps typically only get SELF_ONLY back). Must be queried fresh
 * per post, not hardcoded or cached across creators/audit-status changes.
 */
export async function fetchTikTokCreatorInfo(accessToken) {
  const res = await fetch(CREATOR_INFO, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error?.code !== "ok") {
    const err = new Error(data.error?.message || `TikTok creator info failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data.data;
}

function pickPrivacyLevel(options) {
  const list = Array.isArray(options) ? options : [];
  if (list.includes("PUBLIC_TO_EVERYONE")) return "PUBLIC_TO_EVERYONE";
  return list[0] || "SELF_ONLY";
}

/**
 * Posts one photo directly to the connected TikTok account via PULL_FROM_URL —
 * the imageUrl must be served from a domain/URL prefix registered in the app's
 * TikTok Developer configuration ("Verified URL Prefix"), same as the site's
 * own domain-verification step for the app itself. is_aigc is always true:
 * Amber's captions and cover images are AI-generated, and TikTok's disclosure
 * policy expects that labeled, not something to leave off to look more organic.
 */
export async function publishTikTokPhoto(accessToken, { caption, imageUrl }) {
  const creator = await fetchTikTokCreatorInfo(accessToken);
  const privacyLevel = pickPrivacyLevel(creator?.privacy_level_options);
  const body = {
    post_info: {
      title: String(caption || "").slice(0, 2200),
      privacy_level: privacyLevel,
      disable_comment: false,
      auto_add_music: true,
      is_aigc: true,
    },
    source_info: {
      source: "PULL_FROM_URL",
      photo_cover_index: 0,
      photo_images: [imageUrl],
    },
    post_mode: "DIRECT_POST",
    media_type: "PHOTO",
  };
  const res = await fetch(PHOTO_INIT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error?.code !== "ok") {
    const err = new Error(data.error?.message || `TikTok publish failed (${res.status})`);
    err.status = res.status;
    err.code = data.error?.code;
    throw err;
  }
  return { ...data.data, privacyLevel };
}

export async function fetchTikTokPublishStatus(accessToken, publishId) {
  const res = await fetch(STATUS, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify({ publish_id: publishId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error?.code !== "ok") {
    const err = new Error(data.error?.message || `TikTok status check failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data.data;
}
