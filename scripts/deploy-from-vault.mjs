/**
 * Deploy AmberOne Pages using vault CF credentials from .tmp/cf-env.json.
 * Tries D1 create; continues Pages deploy even if D1 is blocked.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const cf = JSON.parse(readFileSync(path.join(root, ".tmp/cf-env.json"), "utf8"));
if (!cf.CLOUDFLARE_API_TOKEN || !cf.CLOUDFLARE_ACCOUNT_ID) {
  console.log(JSON.stringify({ ok: false, error: "Missing CF env export" }));
  process.exit(1);
}

const env = {
  ...process.env,
  CLOUDFLARE_API_TOKEN: cf.CLOUDFLARE_API_TOKEN,
  CLOUDFLARE_ACCOUNT_ID: cf.CLOUDFLARE_ACCOUNT_ID,
};

function run(args, opts = {}) {
  const res = spawnSync("npx", ["wrangler", ...args], {
    cwd: root,
    env,
    shell: true,
    encoding: "utf8",
  });
  return {
    args,
    status: res.status,
    out: ((res.stdout || "") + (res.stderr || "")).trim(),
  };
}

const report = { at: new Date().toISOString(), steps: [] };

const who = run(["whoami"]);
report.steps.push({ step: "whoami", ok: who.status === 0, snippet: who.out.split("\n").slice(0, 8) });

const d1Create = run(["d1", "create", "amberone"]);
report.steps.push({
  step: "d1 create",
  ok: d1Create.status === 0 || /already exists/i.test(d1Create.out),
  snippet: d1Create.out.split("\n").slice(0, 20),
});

const idMatch = d1Create.out.match(/database_id\s*=\s*"([^"]+)"/i) || d1Create.out.match(/([0-9a-f-]{36})/i);
if (idMatch?.[1] && idMatch[1] !== "local-amberone-db") {
  const tomlPath = path.join(root, "wrangler.toml");
  let toml = readFileSync(tomlPath, "utf8");
  toml = toml.replace(/database_id\s*=\s*"[^"]+"/, `database_id = "${idMatch[1]}"`);
  writeFileSync(tomlPath, toml);
  report.steps.push({ step: "wrangler.toml database_id", ok: true, databaseId: idMatch[1] });
  const migrate = run(["d1", "execute", "amberone", "--remote", "--file=./schema.sql"]);
  report.steps.push({ step: "d1 migrate remote", ok: migrate.status === 0, snippet: migrate.out.split("\n").slice(0, 20) });
} else {
  report.steps.push({ step: "wrangler.toml database_id", ok: false, reason: "Could not parse new D1 id" });
}

const deploy = run(["pages", "deploy", ".", "--project-name=amberone"]);
report.steps.push({
  step: "pages deploy",
  ok: deploy.status === 0,
  snippet: deploy.out.split("\n").slice(-30),
});

const urlMatch = deploy.out.match(/https:\/\/[a-z0-9.-]+\.pages\.dev/i);
report.publicUrl = urlMatch ? urlMatch[0] : null;
report.ok = report.steps.some((s) => s.step === "pages deploy" && s.ok);

writeFileSync(path.join(root, "docs/DEPLOY-ATTEMPT.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
