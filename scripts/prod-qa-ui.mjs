/**
 * Deeper UI QA: dashboard auth redirect, pricing CTAs, nav links, talk panel.
 */
import { chromium, devices } from "playwright";
import { writeFileSync } from "node:fs";

const BASE = "https://amberone.pages.dev";

const report = { at: new Date().toISOString(), checks: [], issues: [] };

function check(name, ok, detail) {
  report.checks.push({ name, ok, detail });
  if (!ok) report.issues.push({ level: "high", name, detail });
}

const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  // Unauthenticated dashboard should redirect to login
  await page.goto(`${BASE}/dashboard/`, { waitUntil: "networkidle", timeout: 45000 });
  await page.waitForTimeout(1500);
  check(
    "dashboard_requires_auth",
    /\/login/.test(page.url()),
    `ended at ${page.url()}`,
  );

  // Pricing plan buttons exist and are clickable targets
  await page.goto(`${BASE}/pricing`, { waitUntil: "networkidle" });
  const planBtns = await page.locator("[data-plan], button[data-checkout], .btn").count();
  check("pricing_has_ctas", planBtns >= 3, `btnCount=${planBtns}`);

  // Click Get started / signup path
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.click('a[href="/signup"], a.nav-cta');
  await page.waitForURL(/signup/, { timeout: 15000 });
  check("home_cta_to_signup", /signup/.test(page.url()), page.url());

  // Talk panel open/close
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.click("#ao-talk-open");
  const open = await page.locator("#ao-talk-panel.is-open").count();
  check("talk_panel_opens", open === 1, `open=${open}`);
  await page.click("#ao-talk-close");
  const closed = await page.locator("#ao-talk-panel.is-open").count();
  check("talk_panel_closes", closed === 0, `open=${closed}`);

  // Full signup → dashboard → logout UI
  const email = `qa.ui.${Date.now()}@example.com`;
  await page.goto(`${BASE}/signup`, { waitUntil: "networkidle" });
  await page.fill("#email", email);
  await page.fill("#password", "QaUiPass123!");
  if (await page.locator("#name").count()) await page.fill("#name", "QA UI");
  await page.click('button[type="submit"]');
  await page.waitForTimeout(2500);
  const afterSignup = page.url();
  check(
    "signup_reaches_dashboard_or_pricing",
    /dashboard|pricing/.test(afterSignup),
    afterSignup,
  );

  if (/dashboard/.test(afterSignup) || (await page.goto(`${BASE}/dashboard/`, { waitUntil: "networkidle" }))) {
    await page.waitForTimeout(1000);
    if (!/login/.test(page.url())) {
      await page.click("[data-logout]");
      await page.waitForTimeout(1500);
      check("logout_returns_home", /amberone\.pages\.dev\/?$/.test(page.url()) || page.url().endsWith("/"), page.url());
    }
  }

  // Mobile nav
  const mobile = await browser.newContext({ ...devices["iPhone 13"] });
  const mp = await mobile.newPage();
  await mp.goto(`${BASE}/pricing`, { waitUntil: "networkidle" });
  await mp.click("[data-nav-toggle]");
  const navOpen = await mp.locator("[data-nav-links].is-open").count();
  check("mobile_nav_toggle", navOpen === 1, `open=${navOpen}`);
  await mp.click('a[href="/faq"]');
  await mp.waitForTimeout(1000);
  check("mobile_nav_faq", /faq/.test(mp.url()), mp.url());
  await mobile.close();

  report.consoleErrors = [...new Set(consoleErrors)].filter(
    (e) => !/status of 401/i.test(e), // expected from /api/auth/me when testing auth gates
  );
  if (report.consoleErrors.length) {
    report.issues.push({ level: "high", name: "console_errors", detail: report.consoleErrors.slice(0, 5).join(" | ") });
  }
} finally {
  await browser.close();
}

writeFileSync("docs/PROD-QA-UI.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(report.issues.length ? 2 : 0);
