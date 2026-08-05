/**
 * Proves the PBKDF2 iteration migration cannot lock anyone out.
 *
 * The danger in raising a hashing cost is that every stored hash was derived at
 * the old cost. If verification uses the new cost, every correct password in the
 * table starts failing. These checks walk the exact lifecycle of a real account
 * across the change.
 *
 * Pure crypto plus a tiny in-memory stand-in for the users row, so it runs with
 * no D1, no network and no deployment.
 */
import assert from "node:assert/strict";
import {
  hashPassword,
  timingSafeEqual,
  randomSaltHex,
  targetIterations,
  iterationsForStoredHash,
  PBKDF2_DEFAULT_ITERATIONS,
  PBKDF2_LEGACY_ITERATIONS,
} from "../functions/_lib/core.js";

let failures = 0;
const check = (label, fn) => {
  try {
    const v = fn();
    assert.equal(v, true);
    console.log(`  PASS  ${label}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${label} — ${e.message}`);
  }
};

/** Exactly what functions/api/auth/login.js does, minus the HTTP wrapper. */
async function attemptLogin(row, password, env) {
  const storedIterations = iterationsForStoredHash(row);
  const hash = await hashPassword(password, row.password_salt, storedIterations);
  if (!timingSafeEqual(hash, row.password_hash)) return { ok: false, row };

  const target = targetIterations(env);
  if (storedIterations < target) {
    const salt = randomSaltHex();
    row = {
      ...row,
      password_salt: salt,
      password_hash: await hashPassword(password, salt, target),
      password_iterations: target,
    };
  }
  return { ok: true, row };
}

console.log("\n=== the cost each hash was made with ===");
check("a row with no column reads as the old 10,000", () => iterationsForStoredHash({}) === 10_000);
check("NULL reads as the old 10,000", () => iterationsForStoredHash({ password_iterations: null }) === 10_000);
check("0 reads as the old 10,000", () => iterationsForStoredHash({ password_iterations: 0 }) === 10_000);
check("a stored count is honoured", () => iterationsForStoredHash({ password_iterations: 250_000 }) === 250_000);

console.log("\n=== the target for new hashes ===");
check("defaults when unset", () => targetIterations({}) === PBKDF2_DEFAULT_ITERATIONS);
check("reads the environment", () => targetIterations({ PBKDF2_ITERATIONS: "310000" }) === 310_000);
check("ignores nonsense", () => targetIterations({ PBKDF2_ITERATIONS: "banana" }) === PBKDF2_DEFAULT_ITERATIONS);
check("refuses a weakening value", () => targetIterations({ PBKDF2_ITERATIONS: "500" }) === PBKDF2_DEFAULT_ITERATIONS);

// An account created before any of this existed: hashed at 10,000, no column.
const legacySalt = randomSaltHex();
const legacyRow = {
  id: "usr_legacy",
  password_salt: legacySalt,
  password_hash: await hashPassword("hunter2-correct-horse", legacySalt, PBKDF2_LEGACY_ITERATIONS),
  // password_iterations deliberately absent — this is what the table looks like
};

console.log("\n=== an existing user, the day the change ships ===");
const first = await attemptLogin(legacyRow, "hunter2-correct-horse", {});
check("their password still works", () => first.ok === true);
check("the hash was upgraded in place", () => first.row.password_iterations === PBKDF2_DEFAULT_ITERATIONS);
check("the stored hash actually changed", () => first.row.password_hash !== legacyRow.password_hash);
check("a fresh salt came with it", () => first.row.password_salt !== legacyRow.password_salt);

console.log("\n=== the same user, next time ===");
const second = await attemptLogin(first.row, "hunter2-correct-horse", {});
check("still works after the upgrade", () => second.ok === true);
check("no second upgrade", () => second.row.password_hash === first.row.password_hash);

console.log("\n=== a wrong password is still wrong ===");
const badBefore = await attemptLogin(legacyRow, "wrong", {});
check("rejected before upgrade", () => badBefore.ok === false);
const badAfter = await attemptLogin(first.row, "wrong", {});
check("rejected after upgrade", () => badAfter.ok === false);
check("a failed attempt does not rewrite the row", () => badAfter.row.password_hash === first.row.password_hash);

console.log("\n=== raising the target again later ===");
const higher = { PBKDF2_ITERATIONS: "310000" };
const third = await attemptLogin(first.row, "hunter2-correct-horse", higher);
check("the 100,000 hash still verifies", () => third.ok === true);
check("and upgrades again to 310,000", () => third.row.password_iterations === 310_000);
const fourth = await attemptLogin(third.row, "hunter2-correct-horse", higher);
check("settles at the new target", () => fourth.ok === true && fourth.row.password_iterations === 310_000);

console.log("\n=== lowering the target does not downgrade anyone ===");
const lower = await attemptLogin(third.row, "hunter2-correct-horse", { PBKDF2_ITERATIONS: "100000" });
check("a stronger hash still verifies", () => lower.ok === true);
check("and is left alone", () => lower.row.password_iterations === 310_000);

console.log("\n=== rollback: the old code path against a migrated row ===");
// If this change were reverted, the old hashPassword(password, salt) would
// default to 100,000 — which is what a migrated row now stores. Verifying the
// rollback story is exactly why the default is the same constant.
const rollbackHash = await hashPassword("hunter2-correct-horse", first.row.password_salt);
check("a migrated row verifies at the default", () => timingSafeEqual(rollbackHash, first.row.password_hash));

console.log(`\n${"=".repeat(62)}`);
console.log(failures === 0 ? "password-migration: all checks passed" : `password-migration: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
