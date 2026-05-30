import { chromium, type Browser, type Page } from "playwright";
import fs from "fs";

const EMAIL      = "paisabrazilfl@gmail.com";
const PASSWORD   = "1Giselle!";
const DOMAIN     = "mtosvelocity.com";
// Render serves both the apex and www custom domains from the same web
// service host. The CNAME target is the api service's onrender hostname.
const CNAME_ROOT = "mtos-api.onrender.com";
const CNAME_WWW  = "mtos-api.onrender.com";
const SS_DIR     = "/tmp/namecom-screenshots";

fs.mkdirSync(SS_DIR, { recursive: true });

async function snap(page: Page, label: string) {
  const f = `${SS_DIR}/${label}-${Date.now()}.png`;
  await page.screenshot({ path: f, fullPage: true }).catch(() => {});
  console.log(`  📸 ${label}: ${f}`);
}

async function dumpPage(page: Page, label: string) {
  await snap(page, label);
  const text = await page.textContent("body").catch(() => "");
  console.log(`  [${label}] url=${page.url()}`);
  console.log(`  [${label}] body(500)=${text?.replace(/\s+/g, " ").slice(0, 500)}`);
  const inputs = await page.evaluate(() =>
    Array.from(document.querySelectorAll("input")).map(e => `${e.type}|${e.name}|${e.id}|${e.placeholder}`)
  );
  const btns = await page.evaluate(() =>
    Array.from(document.querySelectorAll("button,input[type=submit]")).map(e =>
      `${e.tagName}|${(e as any).type}|${e.id}|${e.textContent?.trim().slice(0, 40)}|${e.className.slice(0, 50)}`
    )
  );
  console.log(`  inputs: ${inputs.join(" // ")}`);
  console.log(`  buttons: ${btns.join(" // ")}`);
}

(async () => {
  const browser: Browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  const ctx  = await browser.newContext({ ignoreHTTPSErrors: true, userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" });
  const page: Page = await ctx.newPage();

  try {
    // ── 1. Login ──────────────────────────────────────────────────────────────
    console.log("→ name.com login page...");
    await page.goto("https://www.name.com/account/login", { waitUntil: "networkidle", timeout: 30_000 });
    await dumpPage(page, "01-login");

    // name.com uses acct_name for username
    await page.locator('input[name="acct_name"]').first().fill(EMAIL);
    await page.locator('input[name="password"]').first().fill(PASSWORD);
    console.log("  filled acct_name + password");

    await snap(page, "02-filled");

    // The actual login button has id=login-btn and class contains login-button
    await page.locator('button#login-btn, button.login-button').first().click();
    console.log("  clicked login button");

    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await new Promise(r => setTimeout(r, 3000));
    await dumpPage(page, "03-post-login");

    if (page.url().includes("/login")) {
      console.log("  ✗ Still on login page — wrong password for name.com");
      process.exit(1);
    }
    console.log("  ✓ Logged in, url =", page.url());

    // ── 2. Domain details ─────────────────────────────────────────────────────
    console.log(`\n→ Domain details for ${DOMAIN}...`);
    await page.goto(`https://www.name.com/domain/${DOMAIN}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await dumpPage(page, "04-domain-details");

    // ── 3. DNS page ───────────────────────────────────────────────────────────
    console.log(`\n→ DNS page for ${DOMAIN}...`);
    await page.goto(`https://www.name.com/domain/${DOMAIN}/dns`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await dumpPage(page, "05-dns-page");

  } catch (e: any) {
    console.error("FATAL:", e.message);
    await snap(page, "fatal");
  } finally {
    await browser.close();
  }
})();
