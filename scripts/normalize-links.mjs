import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".wrangler" || name === ".git") continue;
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (/\.(html|js)$/.test(name)) out.push(p);
  }
  return out;
}

const replacements = [
  [/href="\/pricing\.html/g, 'href="/pricing'],
  [/href="\/signup\.html/g, 'href="/signup'],
  [/href="\/login\.html/g, 'href="/login'],
  [/href="\/faq\.html/g, 'href="/faq'],
  [/href="\/privacy\.html/g, 'href="/privacy'],
  [/href="\/terms\.html/g, 'href="/terms'],
  [/href="\/forgot-password\.html/g, 'href="/forgot-password'],
  [/href="\/reset-password\.html/g, 'href="/reset-password'],
  [/href="\/dashboard\/billing\.html/g, 'href="/dashboard/billing'],
  [/href="\/dashboard\/settings\.html/g, 'href="/dashboard/settings'],
  [/location\.href = "\/login\.html"/g, 'location.href = "/login"'],
  [/\/signup\.html/g, "/signup"],
  [/\/login\.html/g, "/login"],
  [/\/pricing\.html/g, "/pricing"],
  [/\/dashboard\/billing\.html/g, "/dashboard/billing"],
  [/\/reset-password\.html/g, "/reset-password"],
];

let changed = 0;
for (const file of walk(process.cwd())) {
  let text = readFileSync(file, "utf8");
  const before = text;
  for (const [re, to] of replacements) text = text.replace(re, to);
  if (text !== before) {
    writeFileSync(file, text);
    changed += 1;
    console.log("updated", path.relative(process.cwd(), file));
  }
}
console.log(JSON.stringify({ changed }, null, 2));
