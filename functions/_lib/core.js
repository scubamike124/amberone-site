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

export function isValidEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!email || email.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

/** Best-effort in-app notification. Never throws. */
export async function createNotification(db, { userId, kind = "info", title, body = null, href = null }) {
  if (!db || !userId || !title) return null;
  try {
    const id = uid("notif");
    await db
      .prepare(
        "INSERT INTO notifications (id, user_id, kind, title, body, href, read_at, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
      )
      .bind(id, userId, String(kind).slice(0, 40), String(title).slice(0, 200), body || null, href || null, nowIso())
      .run();
    return id;
  } catch {
    return null;
  }
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

/**
 * Password hashing cost.
 *
 * This was a bare `10_000`, commented "kept modest for Cloudflare Pages
 * Functions CPU limits". Ten thousand is roughly sixty times weaker than
 * current guidance for PBKDF2-HMAC-SHA256, so a leaked users table would give
 * up weak passwords about sixty times faster than it should.
 *
 * It could not simply be raised. Every stored hash was derived at whatever the
 * constant said at the time, and nothing recorded which — so changing the
 * number would have invalidated every hash in the table and locked out every
 * existing user permanently. That is why `password_iterations` now travels with
 * each row: a hash can always be verified at the cost it was actually created
 * with, whatever the current target happens to be.
 *
 * Measured on WebCrypto, one derivation, median of five:
 *
 *      10,000 →  1.7 ms      150,000 → 22.3 ms
 *      50,000 →  7.6 ms      210,000 → 31.3 ms
 *     100,000 → 15.2 ms      600,000 → 90.1 ms
 *
 * The default is 100,000 — ten times the old cost, and comfortably inside the
 * CPU budget of any paid Workers plan. It is read from the environment so it can
 * be tuned without a code change: raise it as far as the plan's CPU limit
 * allows, and because each row carries its own count, changing it is safe at any
 * time. Nobody is locked out; users re-hash at the new cost the next time they
 * sign in successfully.
 */
export const PBKDF2_DEFAULT_ITERATIONS = 100_000;

/** Cost used for hashes created from now on. */
export function targetIterations(env) {
  const raw = Number(env?.PBKDF2_ITERATIONS ?? 0);
  return Number.isFinite(raw) && raw >= 10_000 ? Math.floor(raw) : PBKDF2_DEFAULT_ITERATIONS;
}

/**
 * The cost a stored hash was created with.
 *
 * Rows written before `password_iterations` existed have NULL there, and every
 * one of those was derived at the old constant — so NULL means 10,000. Getting
 * this wrong in either direction locks people out, which is why it is a named
 * function rather than an inline `|| default`.
 */
export const PBKDF2_LEGACY_ITERATIONS = 10_000;

export function iterationsForStoredHash(row) {
  const stored = Number(row?.password_iterations ?? 0);
  return Number.isFinite(stored) && stored > 0 ? Math.floor(stored) : PBKDF2_LEGACY_ITERATIONS;
}

export async function hashPassword(password, saltHex, iterations = PBKDF2_DEFAULT_ITERATIONS) {
  const salt = hexToBytes(saltHex);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
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

export async function createSession(db, userId, { maxAgeSec } = {}) {
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const id = uid("sess");
  const created = nowIso();
  const ttl = Number.isFinite(maxAgeSec) && maxAgeSec > 0 ? Math.floor(maxAgeSec) : 60 * 60 * 24 * 30;
  const expires = new Date(Date.now() + ttl * 1000).toISOString();
  await db
    .prepare(
      "INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(id, userId, tokenHash, expires, created)
    .run();
  return { token, expires };
}

export async function getUserFromRequest(db, request) {
  if (!db) return null;
  await ensureSchema(db);
  const token = getCookie(request, "ao_session");
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await db
    .prepare(
      `SELECT u.id, u.email, u.name, u.stripe_customer_id, u.plan_slug, u.subscription_status, u.stripe_subscription_id,
              u.account_kind, u.beta_expires_at, s.id AS session_id
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?
       LIMIT 1`,
    )
    .bind(tokenHash, nowIso())
    .first();
  if (!row) return null;
  if (String(row.account_kind || "") === "beta") {
    if (!row.beta_expires_at || row.beta_expires_at < nowIso()) return null;
  }
  return row;
}

export function publicStripeError(message) {
  const raw = String(message || "Checkout failed");
  if (/expired api key/i.test(raw)) {
    return "Billing is temporarily unavailable. The operator needs to rotate the Stripe secret on AmberOne hosting.";
  }
  if (/invalid api key/i.test(raw)) {
    return "Billing is temporarily unavailable. The payment processor is not configured correctly.";
  }
  return raw.replace(/sk_(live|test)_[A-Za-z0-9*_]+/gi, "[redacted]");
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
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: { message: `Stripe returned a non-JSON response (${res.status})` } };
  }
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
  const isBeta = String(row.account_kind || "") === "beta" || String(row.plan_slug || "") === "beta_full";
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    planSlug: row.plan_slug || null,
    subscriptionStatus: row.subscription_status || "none",
    stripeCustomerId: isBeta ? null : row.stripe_customer_id || null,
    isBeta,
    betaExpiresAt: row.beta_expires_at || null,
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
  attendees TEXT,
  visibility TEXT NOT NULL DEFAULT 'private',
  team_id TEXT,
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
    `CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  team_id TEXT,
  name TEXT NOT NULL DEFAULT '',
  description TEXT,
  deadline TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
    `CREATE TABLE IF NOT EXISTS project_members (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  invited_email TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
)`,
    `CREATE TABLE IF NOT EXISTS project_tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  assigned_user_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  body TEXT,
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
    `CREATE TABLE IF NOT EXISTS project_comments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT,
  user_id TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
)`,
    `CREATE TABLE IF NOT EXISTS project_messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
)`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`,
    `CREATE TABLE IF NOT EXISTS beta_invites (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_redeemed_at TEXT,
  created_at TEXT NOT NULL
)`,
    `CREATE INDEX IF NOT EXISTS idx_beta_invites_hash ON beta_invites(token_hash)`,
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
    `CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_project_members_project ON project_members(project_id)`,
    `CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_project_members_email ON project_members(invited_email)`,
    `CREATE INDEX IF NOT EXISTS idx_project_tasks_project ON project_tasks(project_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_project_comments_project ON project_comments(project_id)`,
    `CREATE INDEX IF NOT EXISTS idx_project_messages_project ON project_messages(project_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT,
  name TEXT NOT NULL DEFAULT '',
  content_type TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
    `CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_files_project ON files(project_id)`,
    `CREATE TABLE IF NOT EXISTS social_posts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  caption TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  connected_account_id TEXT,
  ig_user_id TEXT,
  ig_username TEXT,
  creation_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
    `CREATE INDEX IF NOT EXISTS idx_social_posts_user ON social_posts(user_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS business_profiles (
  user_id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  sells TEXT NOT NULL DEFAULT '',
  audience TEXT NOT NULL DEFAULT '',
  offer TEXT NOT NULL DEFAULT '',
  tone TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  objective TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
  ];
  for (const sql of statements) {
    await db.prepare(sql).run();
  }
  // Add team_id to existing tables (safe to fail if column already exists)
  const alters = [
    "ALTER TABLE calendar_events ADD COLUMN team_id TEXT",
    "ALTER TABLE calendar_events ADD COLUMN attendees TEXT",
    "ALTER TABLE calendar_events ADD COLUMN visibility TEXT",
    "ALTER TABLE reminders ADD COLUMN team_id TEXT",
    "ALTER TABLE lists ADD COLUMN team_id TEXT",
    "ALTER TABLE list_items ADD COLUMN team_id TEXT",
    /*
     * Records the PBKDF2 cost each stored hash was created with, so the target
     * can be raised without invalidating anything.
     *
     * Deliberately no DEFAULT and no backfill. Rows that predate this column
     * read NULL, and iterationsForStoredHash() maps NULL to 10,000 — the value
     * every one of them was actually derived at. Writing a default of the *new*
     * target would claim those hashes were made at a cost they were not, and
     * every existing user would fail to log in.
     */
    "ALTER TABLE users ADD COLUMN password_iterations INTEGER",
    "ALTER TABLE users ADD COLUMN account_kind TEXT",
    "ALTER TABLE users ADD COLUMN beta_expires_at TEXT",
    "ALTER TABLE social_posts ADD COLUMN quality_json TEXT",
    "ALTER TABLE social_posts ADD COLUMN brief_json TEXT",
    "ALTER TABLE social_posts ADD COLUMN attempts_json TEXT",
    "ALTER TABLE social_posts ADD COLUMN image_token TEXT",
    "ALTER TABLE social_posts ADD COLUMN image_prompt TEXT",
    "ALTER TABLE social_posts ADD COLUMN campaign_id TEXT",
    "ALTER TABLE social_posts ADD COLUMN scheduled_at TEXT",
    "ALTER TABLE social_posts ADD COLUMN published_at TEXT",
    "ALTER TABLE social_posts ADD COLUMN calendar_event_id TEXT",
  ];
  for (const sql of alters) {
    try { await db.prepare(sql).run(); } catch (_) {}
  }
  try {
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_social_posts_cron ON social_posts(status, scheduled_at)").run();
  } catch (_) {}
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
