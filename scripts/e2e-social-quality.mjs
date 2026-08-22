/**
 * Live quality-gated Instagram compose. Does not publish.
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.AO_BASE || "https://amberoneai.com";
const stamp = Date.now().toString(36);
const email = `ao.qscore.${stamp}@example.com`;
const pass = "HandsOnPass9!";
const cookies = [];
const steps = [];

const brief = {
  name: "Harborline Orthodontics",
  sells:
    "discreet adult clear-aligner treatment and Thursday evening adjustment visits for people who delayed braces",
  audience: "working professionals ages 28-45 in Seattle who want straighter teeth without daytime appointments",
  offer: "complimentary 20-minute evening scan Thursday 5–7pm in Ballard; start plans from $129/month",
  tone: "calm, precise, reassuring, never salesy",
  location: "Ballard, Seattle",
  objective: "fill remaining Thursday evening scan appointments this month",
};

function rec(name, ok, detail) {
  steps.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + String(detail).slice(0, 220) : ""}`);
}

async function api(method, path, body) {
  const headers = { Accept: "application/json" };
  if (cookies.length) headers.Cookie = cookies.join("; ");
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const line of res.headers.getSetCookie?.() || []) cookies.push(line.split(";")[0]);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function main() {
  mkdirSync("docs/social-ig", { recursive: true });
  await api("POST", "/api/auth/signup", { name: "Mina Chen", email, password: pass });
  const saved = await api("POST", "/api/business-profile", brief);
  rec("save specific business brief", saved.status === 200 && saved.json?.profile?.name === brief.name, saved.json?.error);

  const filler = await api("POST", "/api/social-posts", {
    action: "create",
    platform: "instagram",
    caption: "Open for the week — appointments, walk-ins, and evening hours are ready. This is an Amber One professional test post and will not be published live.",
    image_url: "/assets/social/amberone-professional-post.png",
  });
  rec(
    "quality gate rejects generic filler",
    filler.status === 422 && filler.json?.code === "quality_gate" && filler.json?.score?.total < 95,
    `${filler.status} ${filler.json?.score?.total} ${filler.json?.error || ""}`,
  );

  const listed = await api("GET", "/api/social-posts");
  rec(
    "every listed platform can compose under the 95 gate",
    Array.isArray(listed.json?.platforms) &&
      listed.json.platforms.length >= 2 &&
      listed.json.platforms.every((p) => p.canCompose === true && p.qualityPass === 95),
    JSON.stringify((listed.json?.platforms || []).map((p) => ({ id: p.id, canCompose: p.canCompose, canPrepare: p.canPrepare }))),
  );

  const fillerNd = await api("POST", "/api/social-posts", {
    action: "create",
    platform: "nextdoor",
    caption: "Open for the week — appointments, walk-ins, and evening hours are ready. This is an Amber One professional test post and will not be published live.",
    image_url: "/assets/social/amberone-professional-post.png",
  });
  rec(
    "Nextdoor quality gate rejects generic filler",
    fillerNd.status === 422 && fillerNd.json?.code === "quality_gate" && fillerNd.json?.score?.total < 95,
    `${fillerNd.status} ${fillerNd.json?.score?.total} ${fillerNd.json?.error || ""}`,
  );

  const unknown = await api("POST", "/api/social-posts", { action: "compose", platform: "facebook" });
  rec("unsupported network is rejected", unknown.status === 400, `${unknown.status} ${unknown.json?.error || ""}`);

  const composed = await api("POST", "/api/social-posts", { action: "compose", platform: "instagram" });
  rec("Instagram compose caption HTTP", composed.status === 200 && composed.json?.post?.id, composed.json?.error || String(composed.status));
  rec(
    "compose keeps sub-95 filler out of the kept caption",
    Array.isArray(composed.json?.attempts) && composed.json.attempts.some((a) => a.kind === "rejected_generic_template" && a.total < 95),
    JSON.stringify((composed.json?.attempts || []).map((a) => ({ kind: a.kind, total: a.total }))),
  );

  const rendered = await api("POST", "/api/social-posts", { action: "render-image", id: composed.json?.post?.id });
  const score = rendered.json?.score;
  const attempts = rendered.json?.attempts || composed.json?.attempts || [];
  const rejected = attempts.filter((a) => a.passed === false || a.accepted === false);
  rec("render-image HTTP", rendered.status === 201, rendered.json?.error || String(rendered.status));
  rec("final score >= 95", Boolean(score?.passed) && Number(score?.total) >= 95, String(score?.total));
  rec("gate log includes a rejected attempt", rejected.length >= 1, JSON.stringify(rejected.map((a) => ({ kind: a.kind, total: a.total }))));
  rec("caption names Harborline", /Harborline/i.test(rendered.json?.post?.caption || ""), (rendered.json?.post?.caption || "").slice(0, 180));
  rec("no test-post language", !/test post|will not be published|open for the week/i.test(rendered.json?.post?.caption || ""));
  rec("has matching generated image URL", /\/api\/social-image\?/i.test(rendered.json?.post?.image_url || ""), rendered.json?.post?.image_url || "");

  const imgRes = await fetch(rendered.json?.post?.image_url || BASE);
  rec("generated image fetches", imgRes.ok && (imgRes.headers.get("content-type") || "").includes("image"), imgRes.status);

  const ndCompose = await api("POST", "/api/social-posts", { action: "compose", platform: "nextdoor" });
  rec("Nextdoor compose caption HTTP", ndCompose.status === 200 && ndCompose.json?.post?.id, ndCompose.json?.error || String(ndCompose.status));
  rec(
    "Nextdoor compose rejected generic template",
    Array.isArray(ndCompose.json?.attempts) && ndCompose.json.attempts.some((a) => a.kind === "rejected_generic_template" && a.total < 95),
    JSON.stringify((ndCompose.json?.attempts || []).map((a) => ({ kind: a.kind, total: a.total }))),
  );
  const ndRendered = await api("POST", "/api/social-posts", { action: "render-image", id: ndCompose.json?.post?.id });
  rec("Nextdoor render-image HTTP", ndRendered.status === 201, ndRendered.json?.error || String(ndRendered.status));
  rec(
    "Nextdoor final score >= 95",
    Boolean(ndRendered.json?.score?.passed) && Number(ndRendered.json?.score?.total) >= 95,
    String(ndRendered.json?.score?.total),
  );
  rec("Nextdoor caption names Harborline", /Harborline/i.test(ndRendered.json?.post?.caption || ""), (ndRendered.json?.post?.caption || "").slice(0, 180));
  rec("Nextdoor caption names Ballard", /Ballard/i.test(ndRendered.json?.post?.caption || ""));
  rec("Nextdoor not a hashtag dump", ((ndRendered.json?.post?.caption || "").match(/#[A-Za-z0-9_]+/g) || []).length <= 2);
  const ndPrepare = await api("POST", "/api/social-posts", { action: "prepare", id: ndRendered.json?.post?.id });
  rec("Nextdoor prepare does not go live without a connected page", ndPrepare.status === 400 || ndPrepare.status === 503, `${ndPrepare.status} ${ndPrepare.json?.code || ndPrepare.json?.error || ""}`);

  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 1100 } })).newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[type="email"], #email').first().fill(email);
  await page.locator('input[type="password"], #password').first().fill(pass);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL(/dashboard/i, { timeout: 20000 }).catch(() => {});
  await page.goto(`${BASE}/dashboard/business/marketing.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  rec("live UI shows Harborline brief", /Harborline/i.test(await page.content()));
  if (rendered.json?.post?.image_url) {
    await page.evaluate((url) => {
      const img = document.getElementById("preview-img");
      if (img) {
        img.src = url;
        img.hidden = false;
      }
    }, rendered.json.post.image_url);
    await page.evaluate((caption) => {
      const cap = document.getElementById("preview-caption");
      if (cap) cap.textContent = caption;
    }, rendered.json.post.caption);
    await page.waitForTimeout(1200);
  }
  await page.screenshot({ path: "docs/social-ig/quality-full.png", fullPage: true });
  const img = page.locator("#preview-img");
  if (await img.count()) await img.screenshot({ path: "docs/social-ig/quality-image.png" }).catch(() => {});
  await browser.close();

  const report = {
    at: new Date().toISOString(),
    base: BASE,
    email,
    caption: rendered.json?.post?.caption || null,
    imageUrl: rendered.json?.post?.image_url || null,
    score,
    nextdoor: {
      caption: ndRendered.json?.post?.caption || null,
      imageUrl: ndRendered.json?.post?.image_url || null,
      score: ndRendered.json?.score || null,
    },
    attempts,
    rejected: rejected.map((a) => ({ kind: a.kind, total: a.total, reasons: a.reasons })),
    pass: steps.filter((s) => s.ok).length,
    fail: steps.filter((s) => !s.ok).length,
    steps,
  };
  writeFileSync("docs/social-ig/QUALITY-RESULT.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ pass: report.pass, fail: report.fail, instagram: score?.total, nextdoor: ndRendered.json?.score?.total, rejected: report.rejected }, null, 2));
  return report;
}

const report = await main();
process.exit(report.fail || !(report.score?.total >= 95) || !(report.nextdoor?.score?.total >= 95) ? 1 : 0);
