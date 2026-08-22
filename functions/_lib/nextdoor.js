import { nowIso, originFrom } from "./core.js";

const AUTH = "https://www.nextdoor.com/v3/authorize/";
const TOKEN = "https://auth.nextdoor.com/v2/token";
const API = "https://nextdoor.com/external/api/partner/v1";
const SCOPES = "openid post:write post:read profile:read profile publish_api";

function parseJsonSafe(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

export function isNextdoorOAuthConfigured(env) {
  return Boolean(env?.NEXTDOOR_CLIENT_ID && env?.NEXTDOOR_CLIENT_SECRET);
}

export function nextdoorOAuthRedirectUri(request) {
  return `${originFrom(request)}/api/nextdoor-oauth`;
}

export function nextdoorAuthUrl({ clientId, redirectUri, state }) {
  const url = new URL(AUTH);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  return url.toString();
}

function basicAuth(env) {
  return btoa(`${env.NEXTDOOR_CLIENT_ID}:${env.NEXTDOOR_CLIENT_SECRET}`);
}

async function tokenRequest(env, body) {
  if (!isNextdoorOAuthConfigured(env)) {
    throw Object.assign(new Error("Nextdoor publishing is not configured on Amber One yet."), { status: 503, code: "nextdoor_not_configured" });
  }
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth(env)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error_description || data.error || data.message || `Nextdoor token exchange failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function exchangeNextdoorCode(env, { code, redirectUri }) {
  return tokenRequest(env, {
    grant_type: "authorization_code",
    code,
    client_id: env.NEXTDOOR_CLIENT_ID,
    redirect_uri: redirectUri,
  });
}

export async function refreshNextdoorAccessToken(env, refreshToken) {
  return tokenRequest(env, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: SCOPES,
  });
}

export async function activeNextdoor(db, userId) {
  return db
    .prepare(
      `SELECT id, status, metadata_json, composio_connected_account_id
       FROM connected_accounts
       WHERE user_id = ? AND toolkit = 'nextdoor'
       ORDER BY CASE WHEN lower(status) = 'active' THEN 0 ELSE 1 END, updated_at DESC
       LIMIT 1`,
    )
    .bind(userId)
    .first();
}

export async function getNextdoorAccessToken(env, db, connection) {
  const meta = parseJsonSafe(connection?.metadata_json);
  const expiry = Number(meta.expiry || 0);
  if (meta.access_token && (!expiry || Date.now() < expiry - 60_000)) {
    return { accessToken: meta.access_token, meta, connection };
  }
  if (!meta.refresh_token) {
    if (meta.access_token) return { accessToken: meta.access_token, meta, connection };
    return null;
  }
  const tokens = await refreshNextdoorAccessToken(env, meta.refresh_token);
  const next = {
    ...meta,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || meta.refresh_token,
    token_type: tokens.token_type || meta.token_type,
    expiry: Date.now() + Number(tokens.expires_in || 3600) * 1000,
  };
  await db
    .prepare("UPDATE connected_accounts SET metadata_json = ?, status = 'ACTIVE', updated_at = ? WHERE id = ?")
    .bind(JSON.stringify(next), nowIso(), connection.id)
    .run();
  return { accessToken: next.access_token, meta: next, connection };
}

export function pickNextdoorProfile(payload) {
  const list = Array.isArray(payload?.profile_list) ? payload.profile_list : Array.isArray(payload) ? payload : [];
  const business = list.find((p) => p.is_business_profile || p.is_entity_profile);
  const primary = list.find((p) => p.id && p.id === payload?.primary_profile_id);
  const chosen = business || primary || list[0] || null;
  if (!chosen) return null;
  return {
    profileId: String(chosen.id),
    name: chosen.business_name || [chosen.first_name, chosen.last_name].filter(Boolean).join(" ") || null,
    isBusiness: Boolean(chosen.is_business_profile || chosen.is_entity_profile),
  };
}

export async function fetchNextdoorProfiles(accessToken) {
  const res = await fetch(`${API}/me/profiles`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || `Nextdoor profile lookup failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function firstHashtag(caption) {
  const match = String(caption || "").match(/#([A-Za-z0-9_]{2,40})/);
  return match ? match[1] : undefined;
}

export async function createNextdoorPost(accessToken, { caption, imageUrl, profileId }) {
  const body = {
    body_text: String(caption || "").slice(0, 8192),
  };
  const tag = firstHashtag(caption);
  if (tag) body.hashtag = tag;
  if (imageUrl) body.media_attachments = [imageUrl];
  if (profileId) body.secure_profile_id = String(profileId);
  const res = await fetch(`${API}/post/create/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data.result && data.result !== "success")) {
    const err = new Error(data.message || data.error || data.detail || `Nextdoor create post failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}
