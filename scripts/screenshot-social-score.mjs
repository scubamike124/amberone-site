import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.AO_BASE || "https://amberoneai.com";
const email = `ao.score.${Date.now().toString(36)}@example.com`;
mkdirSync("docs/social-ig", { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 1100 } })).newPage();
await page.goto(`${BASE}/signup`, { waitUntil: "domcontentloaded" });
await page.locator('input[type="email"], #email').first().fill(email);
const nameBox = page.locator('input[name="name"], #name');
if (await nameBox.count()) await nameBox.first().fill("Score Reviewer");
await page.locator('input[type="password"], #password').first().fill("HandsOnPass9!");
await page.locator('button[type="submit"]').first().click();
await page.waitForURL(/dashboard/i, { timeout: 20000 }).catch(() => {});
await page.goto(`${BASE}/dashboard/business/marketing.html`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#preview-img", { timeout: 15000 });
await page
  .waitForFunction(() => {
    const img = document.getElementById("preview-img");
    return Boolean(img && img.complete && img.naturalWidth > 0);
  }, { timeout: 15000 })
  .catch(() => {});
await page.locator("article.ao-card.is-hero").screenshot({ path: "docs/social-ig/score-caption-and-image.png" });
await page.locator("#preview-img").screenshot({ path: "docs/social-ig/score-image-only.png" });
await browser.close();
console.log("ok");
