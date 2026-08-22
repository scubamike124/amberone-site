import { nowIso } from "./core.js";

export const BETA_KIND = "beta";
export const BETA_PLAN = "beta_full";
export const BETA_EMAIL = "beta.tester@amberone.local";
export const BETA_NAME = "Amber One beta tester";
export const BETA_TTL_DAYS = 14;

export function isBetaAccount(user) {
  return String(user?.account_kind || "") === BETA_KIND || String(user?.plan_slug || "") === BETA_PLAN;
}

export function betaStillValid(user) {
  if (!isBetaAccount(user)) return false;
  const exp = user?.beta_expires_at;
  if (!exp) return false;
  return String(exp) > nowIso();
}

export function betaForbidden(message) {
  return {
    error: message,
    code: "beta_restricted",
  };
}

export async function ensureBetaSchema(db) {
  if (!db) return;
  await db
    .prepare(
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
    )
    .run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_beta_invites_hash ON beta_invites(token_hash)`).run();
}
