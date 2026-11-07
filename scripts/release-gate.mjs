// Fail-closed release gate. Refuses to pass if the public output dir contains any secret-like
// path or file. Run immediately before `wrangler pages deploy dist`.
import { readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const dist = path.resolve(process.argv[2] || "dist");
if (!existsSync(dist)) { console.error(JSON.stringify({ ok: false, error: "output dir missing: " + dist })); process.exit(1); }
const FORBIDDEN_PATH = [/^\.dev\.vars/i, /(^|\/)\.tmp(\/|$)/i, /(^|\/)\.env(\.|$)/i, /(^|\/)backups(\/|$)/i,
  /(^|\/)docs(\/|$)/i, /(^|\/)scripts(\/|$)/i, /\.sql$/i, /wrangler.*\.toml/i, /(^|\/)\.cursor(\/|$)/i,
  /package(-lock)?\.json$/i, /\.env\.example$/i];
const hits = [];
function walk(dir, rel = "") {
  for (const e of readdirSync(dir)) {
    const abs = path.join(dir, e);
    const r = rel ? rel + "/" + e : e;
    if (FORBIDDEN_PATH.some((re) => re.test(r) || re.test(e))) hits.push(r);
    if (statSync(abs).isDirectory()) walk(abs, r);
  }
}
walk(dist);
if (hits.length) {
  console.error(JSON.stringify({ ok: false, blocked: hits.sort() }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, dir: path.basename(dist), note: "no secret paths in output" }));
