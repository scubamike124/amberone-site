/** Shared helpers for AmberOne Cloudflare Pages Functions */

export const PLANS = {
  personal: { name: "AmberOne Personal", amount: 1999, priceEnv: "STRIPE_PRICE_PERSONAL" },
  family_2: { name: "AmberOne Family (2 users)", amount: 2999, priceEnv: "STRIPE_PRICE_FAMILY_2" },
  family_5: { name: "AmberOne Family (5 users)", amount: 4999, priceEnv: "STRIPE_PRICE_FAMILY_5" },
  family_10: { name: "AmberOne Family (10 users)", amount: 7999, priceEnv: "STRIPE_PRICE_FAMILY_10" },
  executive: { name: "AmberOne Executive", amount: 5999, priceEnv: "STRIPE_PRICE_EXECUTIVE" },
  business_small: { name: "AmberOne Business Small", amount: 9900, priceEnv: "STRIPE_PRICE_BUSINESS_SMALL" },
  business_medium: { name: "AmberOne Business Medium", amount: 19900, priceEnv: "STRIPE_PRICE_BUSINESS_MEDIUM" },
};

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

export function nowIso() {
  return new Date().toISOString();
}

export function uid(prefix = "id") {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export function getCookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  const parts = raw.split(";").map((p) => p.trim());
  for (const part of parts) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    if (part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

export function sessionCookie(token, request, maxAgeSec = 60 * 60 * 24 * 30) {
  const secure = request ? new URL(request.url).protocol === "https:" : false;
  return `ao_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(request) {
  const secure = request ? new URL(request.url).protocol === "https:" : false;
  return `ao_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

export async function sha256Hex(value) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Iterations kept modest for Cloudflare Pages Functions CPU limits. */
export const PBKDF2_ITERATIONS = 10_000;

export async function hashPassword(password, saltHex) {
  const salt = hexToBytes(saltHex);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

/**
 * Constant-time string comparison.
 *
 * `a === b` on a password hash short-circuits at the first differing character,
 * so how long the comparison takes leaks how much of the hash was matched. That
 * is a narrow channel — an attacker has to guess the stored hash rather than the
 * password — but it costs nothing to close and there is no reason to leave a
 * credential check data-dependent.
 */
export function timingSafeEqual(a, b) {
  const x = String(a ?? "");
  const y = String(b ?? "");
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}

export function randomSaltHex(bytes = 16) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return bytesToHex(arr);
}

export function randomToken(bytes = 32) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return bytesToHex(arr);
}

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function createSession(db, userId) {
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const id = uid("sess");
  const created = nowIso();
  const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
  await db
    .prepare(
      "INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(id, userId, tokenHash, expires, created)
    .run();
  return { token, expires };
}

export async function getUserFromRequest(db, request) {
  const token = getCookie(request, "ao_session");
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await db
    .prepare(
      `SELECT u.id, u.email, u.name, u.stripe_customer_id, u.plan_slug, u.subscription_status, u.stripe_subscription_id, s.id AS session_id
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?
       LIMIT 1`,
    )
    .bind(tokenHash, nowIso())
    .first();
  return row || null;
}

export async function stripeForm(secret, path, params) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

export async function verifyStripeSignature(payload, signatureHeader, secret) {
  if (!secret || !signatureHeader) return { ok: false, message: "Missing webhook secret or signature" };
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((p) => {
      const [k, ...rest] = p.trim().split("=");
      return [k, rest.join("=")];
    }),
  );
  const ts = parts.t;
  const v1 = parts.v1;
  if (!ts || !v1) return { ok: false, message: "Malformed Stripe-Signature" };
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(ts));
  if (!Number.isFinite(age) || age > 300) return { ok: false, message: "Signature timestamp outside tolerance" };

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}.${payload}`));
  const expected = bytesToHex(new Uint8Array(mac));
  if (expected.length !== v1.length) return { ok: false, message: "Signature mismatch" };
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0 ? { ok: true, message: "verified" } : { ok: false, message: "Signature mismatch" };
}

export function originFrom(request) {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    planSlug: row.plan_slug || null,
    subscriptionStatus: row.subscription_status || "none",
    stripeCustomerId: row.stripe_customer_id || null,
  };
}

export async function ensureSchema(db) {
  if (!db || ensureSchema._done) return;
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  stripe_customer_id TEXT,
  plan_slug TEXT,
  subscription_status TEXT NOT NULL DEFAULT 'none',
  stripe_subscription_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
    `CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
)`,
    `CREATE TABLE IF NOT EXISTS password_resets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT,
  used_at TEXT,
  created_at TEXT NOT NULL
)`,
    `CREATE TABLE IF NOT EXISTS billing_events (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  type TEXT NOT NULL,
  stripe_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
)`,
    `CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
    `CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  tool_name TEXT,
  tool_payload_json TEXT,
  created_at TEXT NOT NULL
)`,
    `CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'note',
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  importance INTEGER NOT NULL DEFAULT 3,
  source TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
    `CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  description TEXT,
  location TEXT,
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  all_day INTEGER NOT NULL DEFAULT 0,
  recurrence TEXT,
  external_id TEXT,
  external_source TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
    `CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  body TEXT,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  channel TEXT NOT NULL DEFAULT 'app',
  notify_email TEXT,
  calendar_event_id TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
    `CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL DEFAULT '',
  body TEXT,
  href TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL
)`,
    `CREATE TABLE IF NOT EXISTS connected_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  toolkit TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  composio_connected_account_id TEXT,
  auth_config_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
    `CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL
)`,
    `CREATE TABLE IF NOT EXISTS onboarding_state (
  user_id TEXT PRIMARY KEY,
  step TEXT NOT NULL DEFAULT 'welcome',
  completed_at TEXT,
  prefs_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
    `CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
    `CREATE TABLE IF NOT EXISTS lists (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'shopping',
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
    `CREATE TABLE IF NOT EXISTS list_items (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  checked INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
    `CREATE TABLE IF NOT EXISTS briefings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'morning',
  day_key TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  payload_json TEXT,
  source TEXT,
  created_at TEXT NOT NULL
)`,
    `CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  plan_slug TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
    `CREATE TABLE IF NOT EXISTS team_members (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  user_id TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  invited_email TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
)`,
    `CREATE TABLE IF NOT EXISTS chores (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  assigned_user_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  body TEXT,
  recurrence TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  due_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
    `CREATE TABLE IF NOT EXISTS crm_contacts (
  id TEXT PRIMARY KEY,
  team_id TEXT,
  user_id TEXT,
  name TEXT NOT NULL DEFAULT '',
  email TEXT,
  phone TEXT,
  company TEXT,
  notes TEXT,
  tags_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
    `CREATE TABLE IF NOT EXISTS crm_interactions (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  user_id TEXT,
  kind TEXT NOT NULL DEFAULT 'note',
  summary TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
)`,
    `CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY,
  team_id TEXT,
  user_id TEXT,
  contact_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled',
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
    `CREATE TABLE IF NOT EXISTS meeting_prep (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  calendar_event_id TEXT,
  context_json TEXT,
  summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
)`,
    `CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  team_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  trigger_json TEXT,
  actions_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
    `CREATE TABLE IF NOT EXISTS automation_runs (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result_json TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
)`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_resets_user ON password_resets(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users(stripe_customer_id)`,
    `CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id)`,
    `CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(user_id, importance)`,
    `CREATE INDEX IF NOT EXISTS idx_calendar_events_user ON calendar_events(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_calendar_events_starts ON calendar_events(user_id, starts_at)`,
    `CREATE INDEX IF NOT EXISTS idx_reminders_user ON reminders(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(user_id, due_at, status)`,
    `CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at)`,
    `CREATE INDEX IF NOT EXISTS idx_connected_accounts_user ON connected_accounts(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_notes_user ON notes(user_id, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_lists_user ON lists(user_id, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_list_items_list ON list_items(list_id, position)`,
    `CREATE INDEX IF NOT EXISTS idx_briefings_user_day ON briefings(user_id, day_key, mode)`,
    `CREATE INDEX IF NOT EXISTS idx_teams_owner ON teams(owner_user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id)`,
    `CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_chores_team ON chores(team_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_chores_assigned ON chores(assigned_user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_crm_contacts_team ON crm_contacts(team_id)`,
    `CREATE INDEX IF NOT EXISTS idx_crm_contacts_user ON crm_contacts(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_crm_interactions_contact ON crm_interactions(contact_id)`,
    `CREATE INDEX IF NOT EXISTS idx_appointments_team ON appointments(team_id, starts_at)`,
    `CREATE INDEX IF NOT EXISTS idx_appointments_user ON appointments(user_id, starts_at)`,
    `CREATE INDEX IF NOT EXISTS idx_meeting_prep_user ON meeting_prep(user_id, calendar_event_id)`,
    `CREATE INDEX IF NOT EXISTS idx_automations_user ON automations(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_automation_runs ON automation_runs(automation_id)`,
  ];
  for (const sql of statements) {
    await db.prepare(sql).run();
  }
  // Add team_id to existing tables (safe to fail if column already exists)
  const alters = [
    "ALTER TABLE calendar_events ADD COLUMN team_id TEXT",
    "ALTER TABLE reminders ADD COLUMN team_id TEXT",
    "ALTER TABLE lists ADD COLUMN team_id TEXT",
    "ALTER TABLE list_items ADD COLUMN team_id TEXT",
  ];
  for (const sql of alters) {
    try { await db.prepare(sql).run(); } catch (_) {}
  }
  ensureSchema._done = true;
}

/** Record an audit trail entry. Never throws — audit failures must not break the primary action. */
export async function writeAudit(db, { userId, action, resourceType = null, resourceId = null, meta = null }) {
  if (!db || !action) return;
  try {
    await db
      .prepare(
        "INSERT INTO audit_logs (id, user_id, action, resource_type, resource_id, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        uid("audit"),
        userId || null,
        action,
        resourceType,
        resourceId,
        meta ? JSON.stringify(meta) : null,
        nowIso(),
      )
      .run();
  } catch {
    // audit logging is best-effort
  }
}
