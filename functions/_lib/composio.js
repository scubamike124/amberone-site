/**
 * Thin Composio integration client for AmberOne.
 *
 * Composio (https://composio.dev) is the integration hub AmberOne uses to connect
 * third-party toolkits (Google Calendar, Gmail, etc.) on a user's behalf without
 * AmberOne ever handling raw OAuth credentials.
 *
 * Every helper here requires `COMPOSIO_API_KEY` in the environment. When it is
 * missing we throw a `ComposioConfigError` with a clear message so callers can
 * surface a 503 instead of pretending the integration works.
 */

const V3_BASE = "https://backend.composio.dev/api/v3";
const V3_1_BASE = "https://backend.composio.dev/api/v3.1";

export class ComposioConfigError extends Error {
  constructor(message = "Composio is not configured. Set COMPOSIO_API_KEY.") {
    super(message);
    this.name = "ComposioConfigError";
    this.status = 503;
  }
}

export class ComposioApiError extends Error {
  constructor(message, status = 502, data = null) {
    super(message);
    this.name = "ComposioApiError";
    this.status = status;
    this.data = data;
  }
}

export function isComposioConfigured(env) {
  return Boolean(env && env.COMPOSIO_API_KEY);
}

/**
 * Low-level fetch helper against the Composio REST API.
 * `base` defaults to the v3 root; pass `base: "v3.1"` for endpoints (like tool
 * execution) that currently live on the v3.1 surface.
 */
export async function composioFetch(env, path, { method = "GET", body, base = "v3", query } = {}) {
  const apiKey = env?.COMPOSIO_API_KEY;
  if (!apiKey) throw new ComposioConfigError();

  const root = base === "v3.1" ? V3_1_BASE : V3_BASE;
  const url = new URL(`${root}${path.startsWith("/") ? path : `/${path}`}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const v of value) url.searchParams.append(key, String(v));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const res = await fetch(url.toString(), {
    method,
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 500) };
  }

  if (!res.ok) {
    const message = data?.error?.message || data?.message || `Composio request failed (${res.status})`;
    throw new ComposioApiError(message, res.status, data);
  }

  return data;
}

/** List a user's connected accounts, optionally scoped to a toolkit. */
export async function listConnectedAccounts(env, userId, { toolkitSlugs } = {}) {
  if (!userId) throw new Error("userId is required");
  return composioFetch(env, "/connected_accounts", {
    method: "GET",
    query: { user_ids: [userId], toolkit_slugs: toolkitSlugs },
  });
}

export async function getConnectedAccount(env, connectedAccountId) {
  if (!connectedAccountId) throw new Error("connectedAccountId is required");
  return composioFetch(env, `/connected_accounts/${encodeURIComponent(connectedAccountId)}`);
}

export async function deleteConnectedAccount(env, connectedAccountId) {
  if (!connectedAccountId) throw new Error("connectedAccountId is required");
  return composioFetch(env, `/connected_accounts/${encodeURIComponent(connectedAccountId)}`, {
    method: "DELETE",
  });
}

/**
 * Start a Composio Connect Link flow so a user can authorize a toolkit
 * (e.g. Google Calendar). Returns `{ redirectUrl, connectedAccountId, ... }`.
 */
export async function linkAccount(env, { userId, authConfigId, callbackUrl, alias, allowMultiple = true }) {
  if (!userId) throw new Error("userId is required");
  if (!authConfigId) throw new Error("authConfigId is required");
  const data = await composioFetch(env, "/connected_accounts/link", {
    method: "POST",
    body: {
      user_id: userId,
      auth_config_id: authConfigId,
      ...(callbackUrl ? { callback_url: callbackUrl } : {}),
      ...(alias ? { alias } : {}),
      ...(allowMultiple ? { allow_multiple: true } : {}),
    },
  });
  return {
    redirectUrl: data?.redirect_url || data?.redirectUrl || null,
    connectedAccountId: data?.id || data?.connected_account_id || null,
    status: data?.status || "INITIATED",
    raw: data,
  };
}

/** List auth configs available in the Composio project (optionally by toolkit). */
export async function listAuthConfigs(env, { toolkitSlug } = {}) {
  return composioFetch(env, "/auth_configs", {
    method: "GET",
    query: toolkitSlug ? { toolkit_slug: toolkitSlug } : undefined,
  });
}

/**
 * Execute a Composio tool (e.g. `GOOGLECALENDAR_LIST_EVENTS`) on behalf of a user.
 * Lives on the v3.1 surface per Composio's current API reference.
 */
export async function executeTool(env, { slug, userId, connectedAccountId, arguments: args = {} }) {
  if (!slug) throw new Error("Tool slug is required");
  if (!userId && !connectedAccountId) throw new Error("userId or connectedAccountId is required");
  return composioFetch(env, `/tools/execute/${encodeURIComponent(slug)}`, {
    method: "POST",
    base: "v3.1",
    body: {
      ...(userId ? { user_id: userId } : {}),
      ...(connectedAccountId ? { connected_account_id: connectedAccountId } : {}),
      arguments: args,
    },
  });
}

/** Toolkit slug -> auth config env var, kept in one place so it's easy to extend. */
const AUTH_CONFIG_ENV_BY_TOOLKIT = {
  googlecalendar: "COMPOSIO_GOOGLE_CALENDAR_AUTH_CONFIG_ID",
  gmail: "COMPOSIO_GMAIL_AUTH_CONFIG_ID",
};

export function authConfigIdForToolkit(env, toolkit) {
  const key = AUTH_CONFIG_ENV_BY_TOOLKIT[String(toolkit || "").toLowerCase()];
  return key ? env?.[key] || null : null;
}
