// Build a PUBLIC output directory from git-tracked files only, then prune tracked files
// that must never be served. Untracked files (.dev.vars, .tmp/*, backups/*) cannot enter
// dist because `git archive` emits only tracked content.
import { execSync } from "node:child_process";
import { rmSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const dist = path.join(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// Tracked files only -> dist
execSync(`git archive --format=tar HEAD | tar -x -C ${JSON.stringify(dist)}`, { stdio: "inherit" });

// Tracked-but-not-public: internal reports, deploy/build scripts, DB schema, wrangler config,
// node/ts project files, markdown, tests, env example, editor config, standalone workers.
const PRUNE = [
  "docs", "scripts", "schema.sql", "wrangler.toml", "wrangler.local.toml", "wrangler.toml.bak",
  "tsconfig.json", "package.json", "package-lock.json", ".env.example", ".cursor",
  "cron-worker", "www-redirect-worker",
];
for (const p of PRUNE) rmSync(path.join(dist, p), { recursive: true, force: true });
// Drop any remaining markdown (blueprints/readmes) anywhere in the tree.
function walk(dir) {
  for (const e of readdirSync(dir)) {
    const f = path.join(dir, e);
    if (statSync(f).isDirectory()) walk(f);
    else if (/\.(md|mjs|cjs)$/i.test(e)) rmSync(f, { force: true });
  }
}
walk(dist);
console.log("dist assembled from tracked files, internal paths pruned");
