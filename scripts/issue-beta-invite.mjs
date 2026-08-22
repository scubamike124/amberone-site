/**
 * Mint a revocable 14-day Amber One beta magic link.
 * Prints the URL once. Token is not committed.
 */
import { createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const site = join(root, "..");
const cf = JSON.parse(readFileSync(join(site, ".tmp/cf-env.json"), "utf8"));
const ACCOUNT_ID = cf.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = cf.CLOUDFLARE_API_TOKEN;
const DB_ID = "0b00c9b1-dbda-4be4-b603-1b5d3d16bc3a";
const ORIGIN = process.env.AO_BASE || "https://amberoneai.com";
const DAYS = 14;

function hex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

async function d1(sql, params = []) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DB_ID}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sql, params }),
  });
  const data = await res.json();
  if (!res.ok || data.success === false) {
    const err = data.errors?.[0]?.message || JSON.stringify(data.errors || data);
    throw new Error(err);
  }
  return data.result?.[0] || data;
}

async function main() {
  await fetch(`${ORIGIN}/api/auth/beta-invite`).catch(() => {});

  const token = hex(randomBytes(32));
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const salt = hex(randomBytes(16));
  const dummy = hex(randomBytes(24));
  const passwordHash = pbkdf2Sync(dummy, Buffer.from(salt, "hex"), 100000, 32, "sha256").toString("hex");
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + DAYS * 24 * 60 * 60 * 1000).toISOString();
  const email = "beta.tester@amberone.local";
  const name = "Amber One beta tester";

  let userId;
  const existing = await d1("SELECT id FROM users WHERE email = ?", [email]);
  const rows = existing.results || [];
  if (rows[0]?.id) {
    userId = rows[0].id;
    await d1(
      `UPDATE users SET name = ?, account_kind = 'beta', plan_slug = 'beta_full', subscription_status = 'beta',
       stripe_customer_id = NULL, stripe_subscription_id = NULL, beta_expires_at = ?, updated_at = ?
       WHERE id = ?`,
      [name, expires, now, userId],
    );
    await d1("DELETE FROM sessions WHERE user_id = ?", [userId]);
    await d1("UPDATE beta_invites SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", [now, userId]).catch(() => {});
  } else {
    userId = `user_${hex(randomBytes(16))}`;
    await d1(
      `INSERT INTO users (id, email, name, password_hash, password_salt, password_iterations, stripe_customer_id, plan_slug, subscription_status, stripe_subscription_id, created_at, updated_at, account_kind, beta_expires_at)
       VALUES (?, ?, ?, ?, ?, 100000, NULL, 'beta_full', 'beta', NULL, ?, ?, 'beta', ?)`,
      [userId, email, name, passwordHash, salt, now, now, expires],
    );
  }

  const onboard = await d1("SELECT user_id FROM onboarding_state WHERE user_id = ?", [userId]);
  if (!(onboard.results || []).length) {
    await d1(
      `INSERT INTO onboarding_state (user_id, step, prefs_json, completed_at, created_at, updated_at)
       VALUES (?, 'complete', ?, ?, ?, ?)`,
      [userId, JSON.stringify({ beta: true }), now, now, now],
    );
  }
  const team = await d1("SELECT id FROM teams WHERE owner_user_id = ? LIMIT 1", [userId]);
  if (!(team.results || []).length) {
    const teamId = `team_${hex(randomBytes(16))}`;
    await d1(
      "INSERT INTO teams (id, owner_user_id, name, plan_slug, created_at, updated_at) VALUES (?, ?, ?, 'beta_full', ?, ?)",
      [teamId, userId, "Beta family workspace", now, now],
    );
    await d1(
      "INSERT INTO team_members (id, team_id, user_id, role, invited_email, status, created_at) VALUES (?, ?, ?, 'owner', ?, 'active', ?)",
      [`tm_${hex(randomBytes(16))}`, teamId, userId, email, now],
    );
  }

  const inviteId = `beta_${hex(randomBytes(16))}`;
  await d1(
    `INSERT INTO beta_invites (id, user_id, token_hash, label, expires_at, revoked_at, last_redeemed_at, created_at)
     VALUES (?, ?, ?, 'friend-beta', ?, NULL, NULL, ?)`,
    [inviteId, userId, tokenHash, expires, now],
  );

  const url = `${ORIGIN}/beta?token=${encodeURIComponent(token)}`;
  mkdirSync(join(site, ".tmp"), { recursive: true });
  writeFileSync(
    join(site, ".tmp/beta-invite.json"),
    JSON.stringify({ inviteId, expiresAt: expires, url, email, issuedAt: now }, null, 2),
  );
  console.log(JSON.stringify({ ok: true, url, expiresAt: expires, inviteId, days: DAYS }, null, 2));
}

await main();
