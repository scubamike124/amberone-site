/**
 * Live Instagram social compose walkthrough. Stops before Publish.
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.AO_BASE || "https://amberoneai.com";
const stamp = Date.now().toString(36);
const email = `ao.social.${stamp}@example.com`;
const pass = "HandsOnPass9!";
const steps = [];

function rec(name, ok, detail) {
  steps.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + String(detail).slice(0, 180) : ""}`);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(25000);
  mkdirSync("docs/social-ig", { recursive: true });

  try {
    await page.goto(`${BASE}/signup`, { waitUntil: "domcontentloaded" });
    await page.locator('input[type="email"], #email').first().fill(email);
    const nameBox = page.locator('input[name="name"], #name');
    if (await nameBox.count()) await nameBox.first().fill("Social Tester");
    await page.locator('input[type="password"], #password').first().fill(pass);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForURL(/dashboard|onboarding/i, { timeout: 20000 }).catch(() => {});
    rec("signup into product", /dashboard/.test(page.url()), page.url());

    await page.goto(`${BASE}/dashboard/business/marketing.html`, { waitUntil: "domcontentloaded" });
    rec("social page loads", /Social posts|Instagram/i.test(await page.content()));
    rec("instagram option present", (await page.locator("#platform option[value='instagram']").count()) > 0);
    rec("nextdoor option present", (await page.locator("#platform option[value='nextdoor']").count()) > 0);
    rec("image preview present", (await page.locator("#preview-img").count()) > 0);
    rec("caption filled", (await page.locator("#caption").inputValue()).length > 20);

    await page.selectOption("#platform", "nextdoor");
    await page.waitForTimeout(600);
    rec("nextdoor shows unavailable copy", /Nextdoor/i.test(await page.locator("#platform-note").innerText()));
    await page.selectOption("#platform", "instagram");

    await page.click("#save-draft");
    await page.waitForTimeout(1500);
    const afterSave = await page.locator("#banner, #stage").allInnerTexts();
    rec("save instagram draft", /Draft saved|Prepare/i.test(afterSave.join(" ")), afterSave.join(" | ").slice(0, 160));
    await page.screenshot({ path: "docs/social-ig/01-draft.png", fullPage: true });

    const prepareEnabled = await page.locator("#prepare-btn").isEnabled();
    rec("prepare button enabled after draft", prepareEnabled);
    await page.click("#prepare-btn");
    await page.waitForTimeout(2500);
    const afterPrep = await page.locator("#banner, #stage").allInnerTexts();
    const prepText = afterPrep.join(" ");
    const needsConnect = /not connected|Connect Instagram/i.test(prepText);
    const prepared = /unpublished draft|Ready to publish|accepted/i.test(prepText);
    rec("prepare reached Instagram or honest connect-required", needsConnect || prepared, prepText.slice(0, 200));
    await page.screenshot({ path: "docs/social-ig/02-prepare.png", fullPage: true });

    rec("instagram connect button present", (await page.locator("#connect-ig").count()) > 0);
    await Promise.all([
      page.waitForURL(/instagram|facebook|composio|oauth|connect/i, { timeout: 25000 }).catch(() => {}),
      page.click("#connect-ig"),
    ]);
    rec(
      "connect opens real Instagram/Meta OAuth",
      /instagram|facebook|composio/i.test(page.url()),
      page.url().replace(/client_id=[^&]+/, "client_id=PRESENT"),
    );
    await page.screenshot({ path: "docs/social-ig/03-oauth.png", fullPage: true });

    rec("did not click Publish", true, "intentionally stopped before live submission");
  } catch (err) {
    rec("walkthrough crashed", false, err instanceof Error ? err.message : String(err));
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
  writeFileSync("docs/social-ig/RESULT.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ pass: report.pass, fail: report.fail, total: report.total, failed: report.failed }, null, 2));
  return report;
}

const report = await main();
process.exit(report.fail ? 1 : 0);
