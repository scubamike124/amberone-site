import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { execSync } from "node:child_process";
// P0 containment (2026-11-03): never deploy the repo root. Assemble a public-only dist and
// refuse to deploy if the release gate finds any secret path. Fail closed.
execSync("node scripts/assemble-dist.mjs", { stdio: "inherit" });
execSync("node scripts/release-gate.mjs dist", { stdio: "inherit" });

const cf = JSON.parse(readFileSync(".tmp/cf-env.json", "utf8"));
const env = {
  ...process.env,
  CLOUDFLARE_API_TOKEN: cf.CLOUDFLARE_API_TOKEN,
  CLOUDFLARE_ACCOUNT_ID: cf.CLOUDFLARE_ACCOUNT_ID,
};

function run(args) {
  const r = spawnSync("npx", ["wrangler", ...args], {
    env,
    cwd: process.cwd(),
    shell: true,
    encoding: "utf8",
  });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

const create = run(["pages", "project", "create", "amberone", "--production-branch=master"]);
const deploy = run(["pages", "deploy", "dist", "--project-name=amberone"]);
const urlMatch = deploy.out.match(/https:\/\/[a-z0-9.-]+\.pages\.dev/i);
const report = {
  at: new Date().toISOString(),
  createStatus: create.status,
  createOut: create.out.split(/\r?\n/).slice(0, 20),
  deployStatus: deploy.status,
  publicUrl: urlMatch ? urlMatch[0] : null,
  productionAlias: "https://amberone.pages.dev",
  deployTail: deploy.out.split(/\r?\n/).slice(-40),
  d1Binding: {
    binding: "DB",
    database_name: "amberone",
    database_id: "0b00c9b1-dbda-4be4-b603-1b5d3d16bc3a",
  },
  note: "Deployed with D1 binding from wrangler.toml (not stripped).",
};
writeFileSync("docs/DEPLOY-ATTEMPT.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(deploy.status === 0 ? 0 : 1);
