import { ensureSchema, getUserFromRequest, json, readJson, writeAudit } from "../_lib/core.js";
import { isComposioConfigured } from "../_lib/composio.js";
import {
  createEmailDraft,
  fetchEmails,
  getGmailProfile,
  resolveActiveGmailAccount,
} from "../_lib/gmail.js";

export async function onRequestGet(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  if (!isComposioConfigured(context.env)) {
    return json({ error: "Connected Services are not configured yet.", composioConfigured: false }, 503);
  }

  const connection = await resolveActiveGmailAccount(context.env, db, user.id);
  if (!connection?.composio_connected_account_id) {
    return json({
      connected: false,
      emails: [],
      error: "Gmail is not connected yet. Visit Connections to link it.",
    });
  }

  const url = new URL(context.request.url);
  const query = url.searchParams.get("query") || "in:inbox";
  const maxResults = Number(url.searchParams.get("limit") || 10);
  const includeProfile = url.searchParams.get("profile") === "1";

  try {
    const [{ messages }, profile] = await Promise.all([
      fetchEmails(context.env, {
        userId: user.id,
        connectedAccountId: connection.composio_connected_account_id,
        query,
        maxResults,
      }),
      includeProfile
        ? getGmailProfile(context.env, {
            userId: user.id,
            connectedAccountId: connection.composio_connected_account_id,
          })
        : Promise.resolve(null),
    ]);

    await writeAudit(db, {
      userId: user.id,
      action: "gmail.fetch",
      resourceType: "gmail",
      resourceId: connection.composio_connected_account_id,
      meta: { count: messages.length, query },
    });

    return json({
      connected: true,
      connectedAccountId: connection.composio_connected_account_id,
      query,
      emails: messages,
      profile,
    });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err), connected: true }, err?.status || 502);
  }
}

/** POST { action: "draft", recipient_email, subject, body } — creates a draft (does not send). */
export async function onRequestPost(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  if (!isComposioConfigured(context.env)) {
    return json({ error: "Connected Services are not configured yet.", composioConfigured: false }, 503);
  }

  const connection = await resolveActiveGmailAccount(context.env, db, user.id);
  if (!connection?.composio_connected_account_id) {
    return json({ error: "Gmail is not connected yet. Visit Connections to link it." }, 400);
  }

  const body = await readJson(context.request);
  const action = String(body.action || "draft").toLowerCase();
  if (action !== "draft") {
    return json({ error: "Only action=draft is supported. Sending live mail is owner-gated." }, 400);
  }

  try {
    const draft = await createEmailDraft(context.env, {
      userId: user.id,
      connectedAccountId: connection.composio_connected_account_id,
      recipientEmail: body.recipient_email || body.to,
      subject: body.subject,
      body: body.body || body.text,
      isHtml: Boolean(body.is_html || body.isHtml),
    });

    await writeAudit(db, {
      userId: user.id,
      action: "gmail.draft_create",
      resourceType: "gmail_draft",
      resourceId: draft.draftId,
      meta: { to: body.recipient_email || body.to, subject: body.subject },
    });

    return json({ ok: true, draft }, 201);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, err?.status || 502);
  }
}
