import { originFrom, nowIso } from "./core.js";

const CALENDAR_SCOPE =
  "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/userinfo.email";

export function isGoogleCalendarOAuthConfigured(env) {
  return Boolean(env?.GOOGLE_CALENDAR_CLIENT_ID && env?.GOOGLE_CALENDAR_CLIENT_SECRET);
}

export function googleOAuthRedirectUri(request) {
  return `${originFrom(request)}/api/google-calendar-oauth`;
}

export function googleAuthUrl({ clientId, redirectUri, state }) {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", CALENDAR_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return url.toString();
}

async function tokenRequest(env, body) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CALENDAR_CLIENT_ID,
      client_secret: env.GOOGLE_CALENDAR_CLIENT_SECRET,
      ...body,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error_description || data.error || `Google token exchange failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function exchangeGoogleCode(env, { code, redirectUri }) {
  return tokenRequest(env, {
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
}

export async function refreshGoogleAccessToken(env, refreshToken) {
  return tokenRequest(env, {
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
}

export function parseConnectionMeta(row) {
  try {
    return JSON.parse(row?.metadata_json || "{}") || {};
  } catch {
    return {};
  }
}

export async function getGoogleAccessToken(env, db, connection) {
  const meta = parseConnectionMeta(connection);
  const expiry = Number(meta.expiry || 0);
  if (meta.access_token && expiry && Date.now() < expiry - 60_000) {
    return { accessToken: meta.access_token, meta, connection };
  }
  if (!meta.refresh_token) return null;
  const tokens = await refreshGoogleAccessToken(env, meta.refresh_token);
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

export async function listGoogleCalendarEvents(accessToken, { timeMin, timeMax }) {
  const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  url.searchParams.set("timeMin", timeMin);
  url.searchParams.set("timeMax", timeMax);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", "100");
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error?.message || `Google Calendar list failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return Array.isArray(data.items) ? data.items : [];
}

export async function googleUserEmail(accessToken) {
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json().catch(() => ({}));
  return data.email || null;
}
