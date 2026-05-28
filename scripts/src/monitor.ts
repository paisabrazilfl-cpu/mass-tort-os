/**
 * MTOS Playwright Monitor
 *
 * AGENT DEFINITION:
 *   Name:        mtos-playwright-monitor
 *   Purpose:     24/7 browser-level health monitoring of MTOS CRM
 *   Inputs:      MONITOR_BASE_URL, MONITOR_EMAIL, MONITOR_PASSWORD,
 *                CHECK_INTERVAL_MS, MONITOR_LOG_FILE
 *   Allowed:     Read-only browser navigation, HTTP GETs, screenshot capture
 *   Forbidden:   POST/PUT/DELETE mutations, credential logging, DB writes
 *   Stop:        SIGINT · SIGTERM · touch /tmp/mtos-monitor.stop
 *   Escalation:  >= MAX_CONSECUTIVE_FAILURES (3) consecutive failures → [CRITICAL]
 *   Interval:    CHECK_INTERVAL_MS env var (default 300 000 ms / 5 min)
 *
 * CHECKS (in order):
 *   1. api-healthz          GET /api/healthz → 200
 *   2. login-page           /login renders "Sign in to MTOS"
 *   3. auth-login           super_admin credentials succeed → leaves /login
 *   4. dashboard-load       dashboard renders after auth
 *   5. sidebar-nav          all expected section headers visible
 *   6. bos-omega-visible    BOS-OMEGA + Dark Room visible for super_admin
 *   7. leads-page           /leads renders recognisable content
 *   8. no-console-errors    no unhandled JS errors across the session
 *
 * OUTPUTS:
 *   stdout + MONITOR_LOG_FILE (default /tmp/mtos-monitor.log)
 *   Screenshots on failure: /tmp/mtos-monitor-screenshots/
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import fs from "fs";
import path from "path";

const BASE_URL  = process.env.MONITOR_BASE_URL    ?? "https://mtosvelocity.com";
const EMAIL     = process.env.MONITOR_EMAIL        ?? "paisabrazilfl@gmail.com";
const PASSWORD  = process.env.MONITOR_PASSWORD;
const INTERVAL  = parseInt(process.env.CHECK_INTERVAL_MS ?? "300000", 10);
const LOG_FILE  = process.env.MONITOR_LOG_FILE     ?? "/tmp/mtos-monitor.log";
const STOP_FILE = "/tmp/mtos-monitor.stop";
const SS_DIR    = "/tmp/mtos-monitor-screenshots";
const MAX_FAIL  = 3;

type Level = "INFO" | "WARN" | "ERROR" | "CRITICAL";

type CheckResult = {
  name: string;
  passed: boolean;
  detail: string;
  ms: number;
};

// ── helpers ───────────────────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

function log(level: Level, msg: string): void {
  const line = `[${now()}] [${level.padEnd(8)}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch { /* disk full — keep going */ }
}

async function snap(page: Page, name: string): Promise<void> {
  try {
    fs.mkdirSync(SS_DIR, { recursive: true });
    const file = path.join(SS_DIR, `${name}-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: false });
    log("WARN", `  Screenshot saved: ${file}`);
  } catch { /* best-effort */ }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// ── individual checks ─────────────────────────────────────────────────────────

async function checkHttpHealth(): Promise<CheckResult> {
  const t = Date.now();
  try {
    const r = await fetch(`${BASE_URL}/api/healthz`, { signal: AbortSignal.timeout(10_000) });
    return {
      name: "api-healthz",
      passed: r.status === 200,
      detail: `HTTP ${r.status}`,
      ms: Date.now() - t,
    };
  } catch (e: any) {
    return { name: "api-healthz", passed: false, detail: e.message, ms: Date.now() - t };
  }
}

async function checkLoginPage(page: Page): Promise<CheckResult> {
  const t = Date.now();
  try {
    await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    const visible = await page.locator("text=Sign in to MTOS").isVisible().catch(() => false);
    if (!visible) await snap(page, "login-page-fail");
    return {
      name: "login-page",
      passed: visible,
      detail: visible ? "Login page rendered" : '"Sign in to MTOS" not found',
      ms: Date.now() - t,
    };
  } catch (e: any) {
    await snap(page, "login-page-error");
    return { name: "login-page", passed: false, detail: e.message, ms: Date.now() - t };
  }
}

async function checkAuthentication(page: Page): Promise<CheckResult> {
  const t = Date.now();
  if (!PASSWORD) {
    return { name: "auth-login", passed: false, detail: "MONITOR_PASSWORD not set", ms: 0 };
  }
  try {
    const emailInput = page.locator(
      'input[type="email"], input[name="email"], input[placeholder*="mail" i]',
    ).first();
    const passInput  = page.locator('input[type="password"]').first();
    const submit     = page.locator('button[type="submit"], button:has-text("Sign in")').first();

    await emailInput.fill(EMAIL);
    await passInput.fill(PASSWORD);
    await submit.click();

    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20_000 });
    const pathname = new URL(page.url()).pathname;
    return { name: "auth-login", passed: true, detail: `Redirected to ${pathname}`, ms: Date.now() - t };
  } catch (e: any) {
    await snap(page, "auth-fail");
    return { name: "auth-login", passed: false, detail: e.message, ms: Date.now() - t };
  }
}

async function checkDashboard(page: Page): Promise<CheckResult> {
  const t = Date.now();
  try {
    const url       = page.url();
    const notLogin  = !url.includes("/login");
    const hasHeading = await page.locator("h1, h2, [data-testid='dashboard']").first().isVisible().catch(() => false);
    const passed    = notLogin && hasHeading;
    if (!passed) await snap(page, "dashboard-fail");
    return {
      name: "dashboard-load",
      passed,
      detail: passed ? `Dashboard at ${new URL(url).pathname}` : `notLogin=${notLogin} hasHeading=${hasHeading}`,
      ms: Date.now() - t,
    };
  } catch (e: any) {
    return { name: "dashboard-load", passed: false, detail: e.message, ms: Date.now() - t };
  }
}

const EXPECTED_SECTIONS = [
  "Home",
  "Leads & Cases",
  "Documents",
  "Operations",
  "Lead Gen",
  "AI & Clinical",
  "Automation",
  "Settings",
];

async function checkSidebarNav(page: Page): Promise<CheckResult> {
  const t = Date.now();
  try {
    const missing: string[] = [];
    for (const section of EXPECTED_SECTIONS) {
      const found = await page.locator(`nav >> text="${section}"`).first().isVisible().catch(() => false);
      if (!found) missing.push(section);
    }
    const passed = missing.length === 0;
    if (!passed) await snap(page, "sidebar-fail");
    return {
      name: "sidebar-nav",
      passed,
      detail: passed
        ? `All ${EXPECTED_SECTIONS.length} sections visible`
        : `Missing: ${missing.join(", ")}`,
      ms: Date.now() - t,
    };
  } catch (e: any) {
    return { name: "sidebar-nav", passed: false, detail: e.message, ms: Date.now() - t };
  }
}

async function checkBosOmega(page: Page): Promise<CheckResult> {
  const t = Date.now();
  try {
    const bosOmega = await page.locator('nav >> text="BOS-OMEGA"').isVisible().catch(() => false);
    const darkRoom = await page.locator('nav >> text="Dark Room"').isVisible().catch(() => false);
    const passed   = bosOmega && darkRoom;
    if (!passed) await snap(page, "bos-omega-fail");
    return {
      name: "bos-omega-visible",
      passed,
      detail: passed
        ? "BOS-OMEGA + Dark Room visible"
        : `BOS-OMEGA=${bosOmega} DarkRoom=${darkRoom}`,
      ms: Date.now() - t,
    };
  } catch (e: any) {
    return { name: "bos-omega-visible", passed: false, detail: e.message, ms: Date.now() - t };
  }
}

async function checkLeadsPage(page: Page): Promise<CheckResult> {
  const t = Date.now();
  try {
    await page.goto(`${BASE_URL}/leads`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    const hasContent = await page
      .locator("table, [role='grid'], h1, h2, [data-testid]")
      .first()
      .isVisible()
      .catch(() => false);
    if (!hasContent) await snap(page, "leads-fail");
    return {
      name: "leads-page",
      passed: hasContent,
      detail: hasContent ? "/leads loaded" : "No recognisable content on /leads",
      ms: Date.now() - t,
    };
  } catch (e: any) {
    await snap(page, "leads-error");
    return { name: "leads-page", passed: false, detail: e.message, ms: Date.now() - t };
  }
}

// ── one full monitoring cycle ─────────────────────────────────────────────────

async function runCycle(browser: Browser, cycle: number): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const consoleErrors: string[] = [];

  results.push(await checkHttpHealth());

  const ctx: BrowserContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const page: Page = await ctx.newPage();

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      // Ignore benign network-level noise
      if (!text.includes("favicon") && !text.includes("net::ERR_")) {
        consoleErrors.push(text);
      }
    }
  });

  try {
    results.push(await checkLoginPage(page));
    results.push(await checkAuthentication(page));

    const authed = results.find((r) => r.name === "auth-login")?.passed ?? false;
    if (authed) {
      results.push(await checkDashboard(page));
      results.push(await checkSidebarNav(page));
      results.push(await checkBosOmega(page));
      results.push(await checkLeadsPage(page));
    } else {
      log("WARN", `  Skipping post-auth checks (cycle ${cycle}) — auth failed`);
    }

    results.push({
      name: "no-console-errors",
      passed: consoleErrors.length === 0,
      detail:
        consoleErrors.length === 0
          ? "No JS console errors"
          : `${consoleErrors.length} error(s): ${consoleErrors.slice(0, 2).join(" | ")}`,
      ms: 0,
    });
  } finally {
    await ctx.close().catch(() => { /* ignore */ });
  }

  return results;
}

// ── main loop ─────────────────────────────────────────────────────────────────

let stopping = false;
let consecutiveFailures = 0;

async function main(): Promise<void> {
  if (!PASSWORD) {
    log("ERROR", "MONITOR_PASSWORD env var is required. Set it to the super_admin password.");
    log("ERROR", "  export MONITOR_PASSWORD='<password>'");
    process.exit(1);
  }

  log("INFO", "═══════════════════════════════════════════════════════");
  log("INFO", "  MTOS Playwright Monitor starting");
  log("INFO", `  BASE_URL  : ${BASE_URL}`);
  log("INFO", `  EMAIL     : ${EMAIL}`);
  log("INFO", `  INTERVAL  : ${INTERVAL / 1000}s`);
  log("INFO", `  LOG_FILE  : ${LOG_FILE}`);
  log("INFO", `  Stop file : ${STOP_FILE}`);
  log("INFO", "═══════════════════════════════════════════════════════");

  process.on("SIGINT",  () => { log("INFO", "SIGINT — stopping after current cycle"); stopping = true; });
  process.on("SIGTERM", () => { log("INFO", "SIGTERM — stopping after current cycle"); stopping = true; });

  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const browser: Browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
    ...(executablePath ? { executablePath } : {}),
  });
  let cycle = 0;

  try {
    while (!stopping) {
      if (fs.existsSync(STOP_FILE)) {
        log("INFO", `Stop file detected at ${STOP_FILE} — shutting down`);
        try { fs.unlinkSync(STOP_FILE); } catch { /* ok */ }
        break;
      }

      cycle++;
      const cycleStart = Date.now();
      log("INFO", `── Cycle ${cycle} ──────────────────────────────────────`);

      let results: CheckResult[];
      try {
        results = await runCycle(browser, cycle);
      } catch (e: any) {
        log("ERROR", `Cycle ${cycle} threw an unhandled error: ${e.message}`);
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_FAIL) {
          log(
            "CRITICAL",
            `${consecutiveFailures} consecutive failures — the system may be down or unreachable`,
          );
        }
        if (!stopping) await sleep(INTERVAL);
        continue;
      }

      const passed = results.filter((r) => r.passed).length;
      const failed = results.filter((r) => !r.passed).length;
      const cyclMs = Date.now() - cycleStart;

      for (const r of results) {
        log(r.passed ? "INFO" : "ERROR", `  ${r.passed ? "✓" : "✗"} [${r.name}] ${r.detail} (${r.ms}ms)`);
      }

      if (failed === 0) {
        consecutiveFailures = 0;
        log("INFO", `Cycle ${cycle} ✓ PASSED ${passed}/${results.length} in ${cyclMs}ms`);
      } else {
        consecutiveFailures++;
        log("ERROR", `Cycle ${cycle} ✗ FAILED ${failed}/${results.length} in ${cyclMs}ms`);
        if (consecutiveFailures >= MAX_FAIL) {
          log(
            "CRITICAL",
            `${consecutiveFailures} consecutive failures — screenshots at ${SS_DIR}`,
          );
        }
      }

      if (!stopping) {
        log("INFO", `Next check in ${INTERVAL / 1000}s`);
        await sleep(INTERVAL);
      }
    }
  } finally {
    await browser.close().catch(() => { /* ignore */ });
    log("INFO", "Monitor stopped. Browser closed.");
  }
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  log("ERROR", `Fatal: ${msg}`);
  process.exit(1);
});
