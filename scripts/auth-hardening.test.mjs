/**
 * Checks the login hardening added on 2026-08-05.
 *
 * These are pure-crypto paths, so they run here without D1 or a deployment.
 */
import assert from "node:assert/strict";
import { hashPassword, timingSafeEqual, randomSaltHex } from "../functions/_lib/core.js";

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${label} — ${e.message}`);
  }
}

console.log("\n=== timingSafeEqual ===");
check("identical strings match", () => assert.equal(timingSafeEqual("abc123", "abc123"), true));
check("different strings do not", () => assert.equal(timingSafeEqual("abc123", "abc124"), false));
check("length mismatch does not throw and returns false", () =>
  assert.equal(timingSafeEqual("abc", "abcdef"), false));
check("empty vs empty matches", () => assert.equal(timingSafeEqual("", ""), true));
check("null-ish inputs are handled", () => assert.equal(timingSafeEqual(null, undefined), true));
check("a hash never equals a truncated copy of itself", () =>
  assert.equal(timingSafeEqual("deadbeef", "deadbee"), false));

console.log("\n=== password hashing ===");
const salt = randomSaltHex();
const hash = await hashPassword("correct horse battery staple", salt);

check("hash is 32 bytes of hex", () => assert.match(hash, /^[0-9a-f]{64}$/));
check("same password and salt is stable", async () => {
  const again = await hashPassword("correct horse battery staple", salt);
  assert.equal(again, hash);
});
check("a different salt gives a different hash", async () => {
  const other = await hashPassword("correct horse battery staple", randomSaltHex());
  assert.notEqual(other, hash);
});

const again = await hashPassword("correct horse battery staple", salt);
check("verification succeeds through timingSafeEqual", () =>
  assert.equal(timingSafeEqual(again, hash), true));

const wrong = await hashPassword("wrong password", salt);
check("a wrong password fails through timingSafeEqual", () =>
  assert.equal(timingSafeEqual(wrong, hash), false));

console.log("\n=== unknown-user decoy path ===");
// login.js hashes against this fixed salt when no user row is found, so that
// an unknown address costs the same work as a known one.
const DECOY = "00000000000000000000000000000000";
const decoy = await hashPassword("anything at all", DECOY);
check("decoy salt derives without throwing", () => assert.match(decoy, /^[0-9a-f]{64}$/));
check("decoy hash never matches a real hash", () => assert.equal(timingSafeEqual(decoy, hash), false));

console.log(
  `\n${"=".repeat(60)}\nauth-hardening: ${failures === 0 ? "all checks passed" : `${failures} FAILED`}`,
);
process.exit(failures === 0 ? 0 : 1);
