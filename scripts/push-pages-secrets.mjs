/**
 * Push AmberOne Pages secrets from .dev.vars using vault-backed values (no printing).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const raw = readFileSync(".dev.vars", "utf8").replace(/^\uFEFF/, "");
const vars = Object.fromEntries(
  raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf("=");
      return [line.slice(0, i).trim(), line.slice(i + 1)];
    }),
);

const secrets = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "RESEND_API_KEY",
  "OPENAI_API_KEY",
  "EMAIL_FROM",
  "STRIPE_PRICE_PERSONAL",
  "STRIPE_PRICE_FAMILY_2",
  "STRIPE_PRICE_FAMILY_5",
  "STRIPE_PRICE_FAMILY_10",
  "STRIPE_PRICE_EXECUTIVE",
  "STRIPE_PRICE_BUSINESS_SMALL",
  "STRIPE_PRICE_BUSINESS_MEDIUM",
];

const cf = JSON.parse(readFileSync(".tmp/cf-env.json", "utf8"));
const env = {
  ...process.env,
  CLOUDFLARE_API_TOKEN: cf.CLOUDFLARE_API_TOKEN,
  CLOUDFLARE_ACCOUNT_ID: cf.CLOUDFLARE_ACCOUNT_ID,
};

const results = [];
for (const key of secrets) {
  const value = vars[key];
  if (!value) {
    results.push({ key, ok: false, reason: "missing in .dev.vars" });
    continue;
  }
  const r = spawnSync(
    "npx",
    ["wrangler", "pages", "secret", "put", key, "--project-name=amberone"],
    {
      env,
      cwd: process.cwd(),
      shell: true,
      encoding: "utf8",
      input: value + "\n",
    },
  );
  results.push({
    key,
    ok: r.status === 0,
    status: r.status,
    snippet: ((r.stdout || "") + (r.stderr || "")).split(/\r?\n/).slice(0, 6),
  });
}

writeFileSync("docs/PAGES-SECRETS.json", JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
console.log(JSON.stringify({ ok: results.every((r) => r.ok), results: results.map(({ key, ok, reason }) => ({ key, ok, reason })) }, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
