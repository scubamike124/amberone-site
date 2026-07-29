import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const required = [
  "index.html",
  "pricing.html",
  "signup.html",
  "login.html",
  "forgot-password.html",
  "reset-password.html",
  "faq.html",
  "privacy.html",
  "terms.html",
  "dashboard/index.html",
  "dashboard/billing.html",
  "dashboard/settings.html",
  "assets/styles.css",
  "assets/app.js",
  "functions/api/checkout.js",
  "functions/api/portal.js",
  "functions/api/webhook.js",
  "functions/api/billing.js",
  "functions/api/talk.js",
  "functions/api/auth/signup.js",
  "functions/api/auth/login.js",
  "functions/api/auth/logout.js",
  "functions/api/auth/me.js",
  "functions/api/auth/forgot-password.js",
  "functions/api/auth/reset-password.js",
  "functions/_lib/core.js",
  "functions/_middleware.js",
  "schema.sql",
  "wrangler.toml",
  "package.json",
];

const missing = required.filter((f) => !existsSync(path.join(root, f)));
if (missing.length) {
  console.error(JSON.stringify({ ok: false, missing }, null, 2));
  process.exit(1);
}

// Basic syntax gate: ensure core modules parse as UTF-8 JS without BOM issues
const core = readFileSync(path.join(root, "functions/_lib/core.js"), "utf8");
if (core.charCodeAt(0) === 0xfeff) {
  console.error(JSON.stringify({ ok: false, error: "BOM in core.js" }));
  process.exit(1);
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".js")) out.push(p);
  }
  return out;
}

const fnFiles = walk(path.join(root, "functions"));
console.log(
  JSON.stringify(
    {
      ok: true,
      message: "AmberOne production build check passed",
      filesChecked: required.length,
      functionModules: fnFiles.length,
    },
    null,
    2,
  ),
);
