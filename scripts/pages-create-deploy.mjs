import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

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

// Production deploy cannot use placeholder local D1 UUID.
copyFileSync("wrangler.toml", "wrangler.toml.bak");
writeFileSync(
  "wrangler.toml",
  `name = "amberone"
compatibility_date = "2025-07-18"
pages_build_output_dir = "."
`,
);

try {
  const create = run(["pages", "project", "create", "amberone", "--production-branch=master"]);
  const deploy = run(["pages", "deploy", ".", "--project-name=amberone", "--commit-dirty=true"]);
  const urlMatch = deploy.out.match(/https:\/\/[a-z0-9.-]+\.pages\.dev/i);
  const report = {
    createStatus: create.status,
    createOut: create.out.split(/\r?\n/).slice(0, 20),
    deployStatus: deploy.status,
    publicUrl: urlMatch ? urlMatch[0] : null,
    productionAlias: "https://amberone.pages.dev",
    deployTail: deploy.out.split(/\r?\n/).slice(-30),
    note: "Deployed without D1. Auth/signup requires owner to grant D1 Edit on Cloudflare API token (or create D1 in dashboard).",
  };
  writeFileSync("docs/DEPLOY-ATTEMPT.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(deploy.status === 0 ? 0 : 1);
} finally {
  if (existsSync("wrangler.toml.bak")) {
    copyFileSync("wrangler.toml.bak", "wrangler.toml");
  }
}
