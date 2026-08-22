/**
 * Deploy the Amber One social cron Worker and set CRON_SECRET from .tmp (never printed).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const cf = JSON.parse(readFileSync(path.join(root, ".tmp/cf-env.json"), "utf8"));
const cron = JSON.parse(readFileSync(path.join(root, ".tmp/cron-secret.json"), "utf8"));
const secret = String(cron.token || cron.secret || cron.CRON_SECRET || "");
if (!cf.CLOUDFLARE_API_TOKEN || !secret) {
  console.log(JSON.stringify({ ok: false, error: "missing cf token or cron secret" }));
  process.exit(1);
}

const env = {
  ...process.env,
  CLOUDFLARE_API_TOKEN: cf.CLOUDFLARE_API_TOKEN,
  CLOUDFLARE_ACCOUNT_ID: cf.CLOUDFLARE_ACCOUNT_ID,
};

function run(args, extra = {}) {
  const res = spawnSync("npx", ["wrangler", ...args], {
    cwd: path.join(root, "cron-worker"),
    env,
    shell: true,
    encoding: "utf8",
    ...extra,
  });
  const out = `${res.stdout || ""}${res.stderr || ""}`.replaceAll(secret, "[redacted]");
  return { status: res.status, out };
}

const who = run(["whoami"]);
const deploy = run(["deploy"]);
const put = run(["secret", "put", "CRON_SECRET"], { input: secret });
const triggers = run(["triggers", "deploy"]);

const urlMatch = deploy.out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i);
console.log(
  JSON.stringify(
    {
      ok: deploy.status === 0 && put.status === 0,
      whoami: who.status === 0,
      deployStatus: deploy.status,
      secretPutStatus: put.status,
      triggersStatus: triggers.status,
      workerUrl: urlMatch ? urlMatch[0] : null,
      deploySnippet: deploy.out.split("\n").slice(-25),
      putSnippet: put.out.split("\n").slice(-12),
      triggersSnippet: triggers.out.split("\n").slice(-12),
    },
    null,
    2,
  ),
);
process.exit(deploy.status === 0 && put.status === 0 ? 0 : 1);
