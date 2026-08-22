/** Live production probe — no secrets, no mocks. */
const BASE = process.env.AO_BASE || "https://amberoneai.com";

async function hit(method, path, body) {
  const started = Date.now();
  const headers = { Accept: "application/json" };
  const opts = { method, headers, redirect: "manual" };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(`${BASE}${path}`, opts);
    const text = await res.text();
    const ct = res.headers.get("content-type") || "";
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return {
      method,
      path,
      status: res.status,
      ms: Date.now() - started,
      contentType: ct,
      location: res.headers.get("location"),
      json,
      snippet: json ? null : text.replace(/\s+/g, " ").slice(0, 160),
      setCookie: Boolean(res.headers.get("set-cookie")),
    };
  } catch (e) {
    return { method, path, status: 0, error: String(e.message || e), ms: Date.now() - started };
  }
}

const pages = [
  "/",
  "/pricing",
  "/plans",
  "/signup",
  "/login",
  "/forgot-password",
  "/reset-password",
  "/privacy",
  "/terms",
  "/cookies",
  "/faq",
  "/refunds",
  "/acceptable-use",
  "/family",
  "/contact",
  "/robots.txt",
  "/sitemap.xml",
  "/dashboard/",
  "/dashboard/calendar",
  "/dashboard/family/",
  "/dashboard/business/",
  "/dashboard/executive/",
];

const apis = [
  ["GET", "/api/health"],
  ["GET", "/api/auth/me"],
  ["POST", "/api/auth/login", { email: "not-an-email", password: "x" }],
  ["POST", "/api/auth/login", { email: "nobody@example.com", password: "wrongpass1" }],
  ["POST", "/api/auth/signup", { email: "bad", password: "short" }],
  ["POST", "/api/auth/signup", { email: "audit-empty@example.com", password: "short" }],
  ["POST", "/api/auth/forgot-password", { email: "nobody@example.com" }],
  ["POST", "/api/auth/reset-password", { token: "bogus", password: "newpassword1" }],
  ["POST", "/api/talk", { message: "What is AmberOne?" }],
  ["POST", "/api/checkout", { plan: "personal" }],
  ["POST", "/api/checkout", { plan: "enterprise" }],
  ["POST", "/api/portal", {}],
  ["POST", "/api/webhook", {}],
];

const out = { at: new Date().toISOString(), base: BASE, pages: [], apis: [] };
for (const p of pages) out.pages.push(await hit("GET", p));
for (const [m, p, b] of apis) out.apis.push(await hit(m, p, b));

const home = out.pages.find((x) => x.path === "/");
const contact = out.pages.find((x) => x.path === "/contact");
const robots = out.pages.find((x) => x.path === "/robots.txt");
out.flags = {
  contactIsHomepage: contact?.snippet && home?.snippet && contact.snippet.slice(0, 80) === home.snippet.slice(0, 80),
  robotsIsHtml: /html/i.test(robots?.contentType || ""),
  healthOk: out.apis.find((x) => x.path === "/api/health")?.json?.ok === true,
  meUnauthed: out.apis.find((x) => x.path === "/api/auth/me")?.status === 401,
};

console.log(JSON.stringify(out, null, 2));
