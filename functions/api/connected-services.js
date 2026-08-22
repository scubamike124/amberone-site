import { ensureSchema, getUserFromRequest, json, nowIso, originFrom, readJson, uid, writeAudit } from "../_lib/core.js";
import {
  authConfigIdForToolkit,
  deleteConnectedAccount,
  isComposioConfigured,
  linkAccount,
  listConnectedAccounts,
} from "../_lib/composio.js";
import { isGoogleCalendarOAuthConfigured } from "../_lib/google-calendar.js";
import { isNextdoorOAuthConfigured } from "../_lib/nextdoor.js";

/**
 * Connected Services API (Composio hub).
 * Path: /api/connected-services
 * Note: /api/connections POST was blocked by an edge rate-limit rule returning
 * {"error":"Too many requests. Try again shortly."} — this path replaces it.
 */

const SUPPORTED_TOOLKITS = {
  googlecalendar: { provider: "google", label: "Google Calendar" },
  gmail: { provider: "google", label: "Gmail" },
  instagram: { provider: "meta", label: "Instagram" },
  nextdoor: { provider: "nextdoor", label: "Nextdoor" },
};

export async function onRequestGet(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const composioConfigured = isComposioConfigured(context.env);
  const nativeGoogleCalendar = isGoogleCalendarOAuthConfigured(context.env);
  const nativeNextdoor = isNextdoorOAuthConfigured(context.env);
  let composioSyncError = null;
  let remoteItems = [];

  if (composioConfigured) {
    try {
      const remote = await listConnectedAccounts(context.env, user.id);
      remoteItems = remote?.items || remote?.data || [];
      // Upsert ACTIVE remote accounts into local table so sync has the right IDs
      for (const item of remoteItems) {
        const status = String(item.status || "").toUpperCase();
        if (status !== "ACTIVE") continue;
        const toolkit = String(item.toolkit?.slug || item.appName || item.toolkit || "").toLowerCase();
        if (!SUPPORTED_TOOLKITS[toolkit]) continue;
        const existing = await db
          .prepare(
            "SELECT id FROM connected_accounts WHERE user_id = ? AND toolkit = ? ORDER BY updated_at DESC LIMIT 1",
          )
          .bind(user.id, toolkit)
          .first();
        const ts = nowIso();
        if (existing) {
          await db
            .prepare(
              `UPDATE connected_accounts SET status = 'ACTIVE', composio_connected_account_id = ?, updated_at = ?
               WHERE id = ?`,
            )
            .bind(item.id, ts, existing.id)
            .run();
        } else {
          await db
            .prepare(
              `INSERT INTO connected_accounts (id, user_id, provider, toolkit, status, composio_connected_account_id, auth_config_id, metadata_json, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'ACTIVE', ?, NULL, NULL, ?, ?)`,
            )
            .bind(uid("conn"), user.id, SUPPORTED_TOOLKITS[toolkit].provider, toolkit, item.id, ts, ts)
            .run();
        }
      }
    } catch (err) {
      composioSyncError = err instanceof Error ? err.message : String(err);
    }
  }

  const rows = await db
    .prepare(
      "SELECT id, provider, toolkit, status, composio_connected_account_id, auth_config_id, metadata_json, created_at, updated_at FROM connected_accounts WHERE user_id = ? ORDER BY created_at DESC",
    )
    .bind(user.id)
    .all();
  const local = rows.results || [];

  // One card per toolkit — prefer ACTIVE
  const byToolkit = new Map();
  for (const row of local) {
    const prev = byToolkit.get(row.toolkit);
    const score = String(row.status).toUpperCase() === "ACTIVE" ? 2 : 1;
    const prevScore = prev && String(prev.status).toUpperCase() === "ACTIVE" ? 2 : 0;
    if (!prev || score >= prevScore) byToolkit.set(row.toolkit, row);
  }

  const remoteById = new Map(remoteItems.map((i) => [i.id, i]));
  const connections = [...byToolkit.values()].map((row) => {
    const remote = row.composio_connected_account_id ? remoteById.get(row.composio_connected_account_id) : null;
    return {
      id: row.id,
      provider: row.provider,
      toolkit: row.toolkit,
      status: remote?.status || row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });

  return json({
    connections,
    composioConfigured,
    nativeGoogleCalendar,
    nativeNextdoor,
    composioSyncError,
    availableToolkits: Object.entries(SUPPORTED_TOOLKITS).map(([toolkit, meta]) => {
      const composioReady = Boolean(authConfigIdForToolkit(context.env, toolkit));
      const nativeReady =
        (toolkit === "googlecalendar" && nativeGoogleCalendar) || (toolkit === "nextdoor" && nativeNextdoor);
      return {
        toolkit,
        label: meta.label,
        configured: nativeReady || composioReady,
        connectable: nativeReady || (composioConfigured && composioReady),
        connected: connections.some((c) => c.toolkit === toolkit && String(c.status).toUpperCase() === "ACTIVE"),
      };
    }),
  });
}

export async function onRequestPost(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const body = await readJson(context.request);
  const toolkit = String(body.toolkit || "").toLowerCase();
  if (!SUPPORTED_TOOLKITS[toolkit]) {
    return json({ error: `Unsupported toolkit. Choose one of: ${Object.keys(SUPPORTED_TOOLKITS).join(", ")}` }, 400);
  }

  if (toolkit === "nextdoor") {
    if (!isNextdoorOAuthConfigured(context.env)) {
      return json(
        {
          error:
            "Nextdoor publishing is not configured on Amber One yet. Amber needs a Nextdoor Publish API client id and secret from Nextdoor’s partner program.",
          code: "nextdoor_not_configured",
        },
        503,
      );
    }
    return json({
      ok: true,
      redirectUrl: `${originFrom(context.request)}/api/nextdoor-oauth`,
    });
  }

  if (toolkit === "googlecalendar" && isGoogleCalendarOAuthConfigured(context.env)) {
    return json({
      ok: true,
      redirectUrl: `${originFrom(context.request)}/api/google-calendar-oauth`,
    });
  }

  if (!isComposioConfigured(context.env)) {
    return json(
      { error: "Connected Services are not configured yet. Add COMPOSIO_API_KEY to enable Google account connections." },
      503,
    );
  }

  const authConfigId = authConfigIdForToolkit(context.env, toolkit);
  if (!authConfigId) {
    return json(
      {
        error: `No Composio auth config set up for ${SUPPORTED_TOOLKITS[toolkit].label} yet. This toolkit is not available to connect.`,
      },
      503,
    );
  }

  const callbackUrl =
    body.callbackUrl || `${originFrom(context.request)}/dashboard/connections?connected=${toolkit}`;

  // Reuse a recent pending local row if we already started a link (avoid spam)
  const existingPending = await db
    .prepare(
      `SELECT id, composio_connected_account_id, metadata_json, created_at FROM connected_accounts
       WHERE user_id = ? AND toolkit = ? AND status IN ('pending', 'INITIATED', 'INITIALIZING')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(user.id, toolkit)
    .first();

  let link;
  try {
    link = await linkAccount(context.env, {
      userId: user.id,
      authConfigId,
      callbackUrl,
      // Allow reconnect attempts after failed/incomplete OAuth
      allowMultiple: true,
    });
  } catch (err) {
    const status = err?.status || 502;
    const message = err instanceof Error ? err.message : String(err);
    // Friendlier copy for rate limits / duplicate guards
    if (status === 429) {
      return json(
        {
          error: "Composio is rate-limiting connect attempts. Wait about a minute, then try Connect again.",
          detail: message,
        },
        429,
      );
    }
    return json({ error: message }, status >= 400 && status < 600 ? status : 502);
  }

  if (!link.redirectUrl) {
    return json({ error: "Composio did not return a connect URL. Try again in a moment." }, 502);
  }

  const id = existingPending?.id || uid("conn");
  const ts = nowIso();
  if (existingPending) {
    await db
      .prepare(
        `UPDATE connected_accounts SET status = ?, composio_connected_account_id = COALESCE(?, composio_connected_account_id),
         auth_config_id = ?, metadata_json = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      )
      .bind(
        link.status || "pending",
        link.connectedAccountId || null,
        authConfigId,
        JSON.stringify({ callbackUrl, redirectUrl: link.redirectUrl }),
        ts,
        id,
        user.id,
      )
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO connected_accounts (id, user_id, provider, toolkit, status, composio_connected_account_id, auth_config_id, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        user.id,
        SUPPORTED_TOOLKITS[toolkit].provider,
        toolkit,
        link.status || "pending",
        link.connectedAccountId || null,
        authConfigId,
        JSON.stringify({ callbackUrl, redirectUrl: link.redirectUrl }),
        ts,
        ts,
      )
      .run();
  }

  await writeAudit(db, {
    userId: user.id,
    action: "connection.link_started",
    resourceType: "connected_account",
    resourceId: id,
    meta: { toolkit },
  });

  return json({ ok: true, redirectUrl: link.redirectUrl, connectionId: id }, 201);
}

export async function onRequestDelete(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const url = new URL(context.request.url);
  const id = url.searchParams.get("id");
  if (!id) return json({ error: "id query parameter required" }, 400);

  const existing = await db
    .prepare("SELECT id, composio_connected_account_id FROM connected_accounts WHERE id = ? AND user_id = ?")
    .bind(id, user.id)
    .first();
  if (!existing) return json({ error: "Connection not found" }, 404);

  let composioDeleteError = null;
  if (existing.composio_connected_account_id && isComposioConfigured(context.env)) {
    try {
      await deleteConnectedAccount(context.env, existing.composio_connected_account_id);
    } catch (err) {
      composioDeleteError = err instanceof Error ? err.message : String(err);
    }
  }

  await db.prepare("DELETE FROM connected_accounts WHERE id = ? AND user_id = ?").bind(id, user.id).run();
  await writeAudit(db, {
    userId: user.id,
    action: "connection.disconnect",
    resourceType: "connected_account",
    resourceId: id,
    meta: { composioDeleteError },
  });

  return json({ ok: true, composioDeleteError });
}
