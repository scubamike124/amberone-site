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

export async function hashPassword(password, saltHex) {
  const salt = hexToBytes(saltHex);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 120000 },
    key,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
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
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
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
    `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_resets_user ON password_resets(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users(stripe_customer_id)`,
  ];
  for (const sql of statements) {
    await db.prepare(sql).run();
  }
  ensureSchema._done = true;
}
