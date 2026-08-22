/**
 * Browser UI walkthrough — click forms like a customer.
 * Uses Playwright against the live site. No live card charge.
 */
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";

const BASE = process.env.AO_BASE || "https://amberoneai.com";
const stamp = Date.now().toString(36);
const pass = "HandsOnPass9!";
const email = `ao.ui.${stamp}@example.com`;
const steps = [];

function rec(name, ok, detail) {
  steps.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + String(detail).slice(0, 140) : ""}`);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" });
  const page = await desktop.newPage();
  page.setDefaultTimeout(20000);

  try {
    await page.goto(`${BASE}/signup`, { waitUntil: "domcontentloaded" });
    rec("signup page", /sign up|create/i.test(await page.content()), page.url());
    await page.locator('input[type="email"], input[name="email"], #email').first().fill(email);
    const nameBox = page.locator('input[name="name"], #name');
    if (await nameBox.count()) await nameBox.first().fill("UI Tester");
    await page.locator('input[type="password"], #password').first().fill(pass);
    await page.locator('button[type="submit"], button:has-text("Sign up"), button:has-text("Create")').first().click();
    await page.waitForURL(/dashboard|onboarding|pricing/i, { timeout: 20000 }).catch(() => {});
    rec("signup submit lands in product", /dashboard|onboarding/.test(page.url()), page.url());

    await page.goto(`${BASE}/dashboard/calendar`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#title, input#title", { timeout: 15000 });
    await page.fill("#title", "Piano lesson");
    await page.fill("#starts_at", "2026-08-21T16:00");
    await page.fill("#ends_at", "2026-08-21T17:00");
    await page.fill("#location", "Music studio");
    await page.fill("#description", "Bring books");
    await page.fill("#people", "Maya, Ms. Chen");
    await page.selectOption("#recurrence", "weekly");
    await page.selectOption("#visibility", "private");
    await page.click("#save-btn");
    await page.waitForTimeout(1500);
    const calText = await page.locator("#events-list").innerText();
    rec("calendar form create shows event", /Piano lesson/i.test(calText), calText.slice(0, 120));
    rec("calendar has Connect Google", /Connect Google Calendar/i.test(await page.content()));
    rec("calendar has Sync from Google", /Sync from Google/i.test(await page.content()));
    const edit = page.locator("button:has-text('Edit')").first();
    rec("calendar edit button present", (await edit.count()) > 0);
    if (await edit.count()) {
      await edit.click();
      await page.fill("#title", "Piano lesson (moved)");
      await page.fill("#starts_at", "2026-08-22T16:00");
      await page.click("#save-btn");
      await page.waitForTimeout(1200);
      rec("calendar edit/reschedule via UI", /moved/i.test(await page.locator("#events-list").innerText()), "updated list");
    }

    await page.goto(`${BASE}/dashboard/files`, { waitUntil: "domcontentloaded" });
    rec("files page", /Upload|Your files/i.test(await page.content()));
    await page.goto(`${BASE}/dashboard/connections`, { waitUntil: "domcontentloaded" });
    rec("connections Google Calendar connectable", /Google Calendar/i.test(await page.content()) && /Ready to connect|Connect/i.test(await page.content()));

    await page.goto(`${BASE}/dashboard/reminders`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#title");
    await page.fill("#title", "Pack lunch");
    await page.fill("#due_at", "2026-08-19T07:00");
    await page.selectOption("#channel", "app");
    await page.click("button[type='submit']");
    await page.waitForTimeout(1200);
    rec("reminders form create", /Pack lunch/i.test(await page.locator("#reminders-list").innerText()));

    await page.goto(`${BASE}/dashboard/notes`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#note-body");
    await page.fill("#note-title", "Grocery thought");
    await page.fill("#note-body", "Need sourdough and berries.");
    await page.click("#note-form button[type='submit']");
    await page.waitForTimeout(1000);
    rec("notes form create", /sourdough/i.test(await page.locator("#notes-list").innerText()));
    await page.fill("#list-title", "Shop");
    await page.fill("#list-items", "Milk\nEggs");
    await page.click("#list-form button[type='submit']");
    await page.waitForTimeout(1000);
    rec("lists form create", /Shop|Milk/i.test(await page.locator("#lists-panel").innerText()));

    await page.goto(`${BASE}/dashboard/projects`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#proj-name");
    await page.fill("#proj-name", "Backyard fence");
    await page.fill("#proj-desc", "Replace the south side.");
    await page.click("#project-form button[type='submit']");
    await page.waitForFunction(() => /Backyard fence/i.test(document.querySelector("#project-list")?.innerText || ""), { timeout: 15000 }).catch(() => {});
    rec("projects form create", /Backyard fence/i.test(await page.locator("#project-list").innerText().catch(() => "")));
    const created = page.locator("#project-list").getByText("Backyard fence").first();
    if (await created.count()) {
      await created.click();
      await page.waitForSelector("#detail:not([hidden])", { timeout: 8000 }).catch(() => {});
    }
    if (await page.locator("#detail:not([hidden]) #invite-email").count()) {
      await page.fill("#detail:not([hidden]) #invite-email", `ao.ui.invite.${stamp}@example.com`);
      await page.click("#invite-form button[type='submit']");
      await page.waitForTimeout(800);
      rec("projects invite via UI", /pending|Invite/i.test(await page.content()));
    }
    if (await page.locator("#detail:not([hidden]) #task-title").count()) {
      await page.fill("#detail:not([hidden]) #task-title", "Buy posts");
      await page.click("#task-form button[type='submit']");
      await page.waitForTimeout(800);
      rec("projects add task via UI", /Buy posts/i.test(await page.locator("#tasks-list").innerText().catch(() => "")));
    }

    await page.goto(`${BASE}/dashboard/family/`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    const createTeam = page.locator("#create-team");
    if (await createTeam.count() && await createTeam.isVisible()) {
      page.once("dialog", (d) => d.accept("UI Family"));
      await createTeam.click();
      await page.waitForTimeout(1000);
    }
    rec("family dashboard", /Family|team|chore/i.test(await page.content()));

    await page.goto(`${BASE}/dashboard/settings`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => {
      const el = document.getElementById("email");
      return el && el.textContent && el.textContent.includes("@");
    }, { timeout: 10000 }).catch(() => {});
    rec("settings shows account email", (await page.locator("#email").innerText().catch(() => "")).includes(email) || /@example.com/.test(await page.content()), "settings");

    await page.goto(`${BASE}/dashboard/billing`, { waitUntil: "domcontentloaded" });
    rec("billing page", /plan|billing|stripe|upgrade/i.test(await page.content()));

    await page.goto(`${BASE}/dashboard/notifications`, { waitUntil: "domcontentloaded" });
    rec("notifications page", /Notification/i.test(await page.content()));
    if (await page.locator("#read-all").count()) await page.click("#read-all");

    await page.goto(`${BASE}/dashboard/`, { waitUntil: "domcontentloaded" });
    rec("home dashboard", /Talk to Amber|Schedule|Briefing/i.test(await page.content()));
    const talk = page.locator("#dash-talk-input");
    if (await talk.count()) {
      await talk.fill("What's on my calendar?");
      await page.click("#dash-talk button[type='submit']");
      await page.waitForTimeout(12000);
      rec("home talk submit", /piano|calendar|Amber|lesson/i.test(await page.locator("#talk-log").innerText().catch(() => "")));
    }

    const mpage = await mobile.newPage();
    await mpage.goto(`${BASE}/dashboard/calendar`, { waitUntil: "domcontentloaded" });
    rec("mobile calendar usable", (await mpage.locator("#event-form").count()) > 0);
    await mpage.close();

    await page.goto(`${BASE}/dashboard/settings`, { waitUntil: "domcontentloaded" });
    const logout = page.locator("[data-logout]").last();
    if (await logout.count()) {
      await logout.click();
      await page.waitForTimeout(1500);
    }
    rec("logout via UI", /login|signup|Amber/i.test(page.url() + (await page.content()).slice(0, 200)), page.url());

    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
    await page.locator('input[type="email"], #email').first().fill(email);
    await page.locator('input[type="password"], #password').first().fill(pass);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForURL(/dashboard/i, { timeout: 15000 }).catch(() => {});
    rec("login via UI after logout", /dashboard/.test(page.url()), page.url());
    await page.goto(`${BASE}/dashboard/calendar`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);
    rec("calendar persisted after UI re-login", /Piano lesson/i.test(await page.locator("#events-list").innerText()));
  } catch (err) {
    rec("ui walkthrough crashed", false, err instanceof Error ? err.message : String(err));
  } finally {
    await browser.close();
  }

  const report = {
    at: new Date().toISOString(),
    base: BASE,
    email,
    pass: steps.filter((s) => s.ok).length,
    fail: steps.filter((s) => !s.ok).length,
    total: steps.length,
    failed: steps.filter((s) => !s.ok).map((s) => s.name),
    steps,
  };
  mkdirSync("docs", { recursive: true });
  writeFileSync("docs/HANDS-ON-UI.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ pass: report.pass, fail: report.fail, total: report.total, failed: report.failed }, null, 2));
  return report;
}

const report = await main();
process.exit(report.fail ? 1 : 0);
