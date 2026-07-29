import { nowIso } from "./core.js";
import { executeTool, isComposioConfigured, listConnectedAccounts } from "./composio.js";

export const GMAIL_TOOLKIT = "gmail";
export const FETCH_EMAILS_TOOL = "GMAIL_FETCH_EMAILS";
export const CREATE_DRAFT_TOOL = "GMAIL_CREATE_EMAIL_DRAFT";
export const GET_PROFILE_TOOL = "GMAIL_GET_PROFILE";

export async function resolveActiveGmailAccount(env, db, userId) {
  let remoteActiveId = null;
  try {
    const remote = await listConnectedAccounts(env, userId, { toolkitSlugs: [GMAIL_TOOLKIT] });
    const items = remote?.items || remote?.data || [];
    const active = items.find((i) => String(i.status || "").toUpperCase() === "ACTIVE");
    if (active?.id) remoteActiveId = active.id;
  } catch {
    // fall back to local
  }

  let connection = await db
    .prepare(
      `SELECT id, composio_connected_account_id, status FROM connected_accounts
       WHERE user_id = ? AND toolkit = ?
       ORDER BY CASE WHEN lower(status) = 'active' THEN 0 ELSE 1 END, updated_at DESC
       LIMIT 1`,
    )
    .bind(userId, GMAIL_TOOLKIT)
    .first();

  if (remoteActiveId && connection) {
    if (connection.composio_connected_account_id !== remoteActiveId) {
      await db
        .prepare(
          "UPDATE connected_accounts SET composio_connected_account_id = ?, status = 'ACTIVE', updated_at = ? WHERE id = ?",
        )
        .bind(remoteActiveId, nowIso(), connection.id)
        .run();
      connection = { ...connection, composio_connected_account_id: remoteActiveId, status: "ACTIVE" };
    }
  } else if (remoteActiveId && !connection) {
    // Remote ACTIVE but no local row — still usable via composio id alone
    return { id: null, composio_connected_account_id: remoteActiveId, status: "ACTIVE" };
  }

  return connection;
}

function collectMessages(payload) {
  if (!payload || typeof payload !== "object") return [];
  const candidates = [
    payload?.data?.messages,
    payload?.data?.data?.messages,
    payload?.messages,
    payload?.data?.items,
    payload?.items,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  // Sometimes a single message object
  if (payload?.data?.messageId || payload?.data?.id) return [payload.data];
  return [];
}

export function normalizeEmailMessage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const messageId = raw.messageId || raw.message_id || raw.id || null;
  const threadId = raw.threadId || raw.thread_id || null;
  const subject = raw.subject || raw.Subject || raw.headers?.subject || "(no subject)";
  const from = raw.sender || raw.from || raw.From || raw.headers?.from || null;
  const to = raw.recipient || raw.to || raw.To || raw.headers?.to || null;
  const snippet = raw.snippet || raw.preview || raw.bodyPreview || null;
  const internalDate = raw.internalDate || raw.internal_date || raw.date || raw.Date || null;
  const labelIds = raw.labelIds || raw.label_ids || [];
  return {
    messageId,
    threadId,
    subject: String(subject).slice(0, 300),
    from: from ? String(from).slice(0, 300) : null,
    to: to ? String(to).slice(0, 300) : null,
    snippet: snippet ? String(snippet).slice(0, 500) : null,
    internalDate,
    labelIds,
  };
}

export async function fetchEmails(env, { userId, connectedAccountId, query, maxResults = 10, labelIds }) {
  if (!isComposioConfigured(env)) {
    throw Object.assign(new Error("Composio is not configured"), { status: 503 });
  }
  if (!connectedAccountId) {
    throw Object.assign(new Error("Gmail is not connected yet. Visit Connections to link it."), { status: 400 });
  }

  const toolResult = await executeTool(env, {
    slug: FETCH_EMAILS_TOOL,
    userId,
    connectedAccountId,
    arguments: {
      max_results: Math.min(50, Math.max(1, Number(maxResults) || 10)),
      verbose: false,
      include_payload: false,
      ...(query ? { query: String(query) } : {}),
      ...(Array.isArray(labelIds) && labelIds.length ? { label_ids: labelIds } : {}),
    },
  });

  const messages = collectMessages(toolResult)
    .map(normalizeEmailMessage)
    .filter(Boolean)
    .sort((a, b) => String(b.internalDate || "").localeCompare(String(a.internalDate || "")));

  return { messages, rawSuccessful: toolResult?.successful !== false, toolResult };
}

export async function createEmailDraft(env, { userId, connectedAccountId, recipientEmail, subject, body, isHtml = false }) {
  if (!isComposioConfigured(env)) {
    throw Object.assign(new Error("Composio is not configured"), { status: 503 });
  }
  if (!connectedAccountId) {
    throw Object.assign(new Error("Gmail is not connected yet. Visit Connections to link it."), { status: 400 });
  }
  if (!recipientEmail) {
    throw Object.assign(new Error("recipient_email is required"), { status: 400 });
  }
  if (!subject && !body) {
    throw Object.assign(new Error("subject or body is required"), { status: 400 });
  }

  const toolResult = await executeTool(env, {
    slug: CREATE_DRAFT_TOOL,
    userId,
    connectedAccountId,
    arguments: {
      recipient_email: String(recipientEmail),
      ...(subject ? { subject: String(subject).slice(0, 500) } : {}),
      ...(body ? { body: String(body) } : {}),
      is_html: Boolean(isHtml),
    },
  });

  const data = toolResult?.data || toolResult || {};
  const draftId = data.draft_id || data.draftId || data.id || data?.data?.id || null;
  return { draftId, raw: data, successful: toolResult?.successful !== false };
}

export async function getGmailProfile(env, { userId, connectedAccountId }) {
  if (!connectedAccountId) return null;
  try {
    const toolResult = await executeTool(env, {
      slug: GET_PROFILE_TOOL,
      userId,
      connectedAccountId,
      arguments: {},
    });
    const data = toolResult?.data || toolResult || {};
    return {
      emailAddress: data.emailAddress || data.email_address || data.email || null,
      messagesTotal: data.messagesTotal ?? data.messages_total ?? null,
      threadsTotal: data.threadsTotal ?? data.threads_total ?? null,
    };
  } catch {
    return null;
  }
}
