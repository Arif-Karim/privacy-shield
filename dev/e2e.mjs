// The backend allows 10 requests a minute per IP, and this makes ~9 — wait a
// minute between runs (dev/build.sh runs this after every build).
//
// End-to-end check: loads the extension from this repo into a real Chromium,
// opens phone-form pages and checks what the user would see. Talks to the
// live backend, but only with free (non-licensed) requests, which never
// trigger a paid analysis. Run: cd dev && npm test
import { chromium } from "playwright";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// dev/build.sh points this at the store build; defaults to the repo itself.
const EXTENSION_DIR = resolve(import.meta.dirname, process.env.EXTENSION_DIR || "..");
const BANNER = "#privacy-shield-banner";

// Pages are served by Playwright itself, so no server is needed. The privacy
// link decides which site gets rated.
function formPage(policyUrl) {
  return `<!doctype html><title>test</title><h1>Get a quote</h1>
<label>Mobile number <input type="tel" name="phone"></label>
${policyUrl ? `<a href="${policyUrl}">Privacy policy</a>` : ""}`;
}

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(["PASS", name]);
  } catch (err) {
    results.push(["FAIL", name, err.message.split("\n")[0]]);
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "ps-e2e-")), {
  channel: "chromium",
  headless: true,
  args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
});
let [worker] = context.serviceWorkers();
worker ??= await context.waitForEvent("serviceworker");

const pages = new Map(); // URL → policy link
await context.route(/^http:\/\/[a-z]+\.e2e\.test\//, (route) => {
  const policyUrl = pages.get(route.request().url());
  route.fulfill({ contentType: "text/html", body: formPage(policyUrl) });
});

// Returns what the background stored for the page's tab (what the popup
// shows). Each test uses its own hostname, so the stored request identifies it.
async function tabResult(page) {
  return worker.evaluate(async (domain) => {
    const all = await chrome.storage.session.get(null);
    return Object.values(all).find((s) => s.request.domain === domain)?.result ?? null;
  }, new URL(page.url()).hostname);
}

async function openForm(path, policyUrl) {
  const url = `http://${path}.e2e.test/`;
  pages.set(url, policyUrl);
  const page = await context.newPage();
  const logs = [];
  page.on("console", (m) => logs.push(m.text()));
  await page.goto(url);
  return { page, logs };
}

await check("unchecked site: banner asks the user to open the extension", async () => {
  // A made-up domain is guaranteed not to be in the database.
  const { page } = await openForm("unchecked", `https://e2e-${Date.now()}.example.com/privacy`);
  const banner = page.locator(BANNER);
  await banner.waitFor({ timeout: 15000 });
  const text = await banner.innerText();
  assert(text.includes("we haven't checked this site yet"), `banner said: ${text.slice(0, 120)}`);
  const result = await tabResult(page);
  assert(result?.reason === "not_checked_yet", `stored result: ${JSON.stringify(result)}`);
  await page.close();
});

await check("checked site: rating comes from the database, no paywall", async () => {
  const { page } = await openForm("cached", "https://www.mozilla.org/en-US/privacy/websites/");
  let result = null;
  for (let i = 0; i < 30 && !result; i++) {
    await page.waitForTimeout(500);
    result = await tabResult(page);
  }
  assert(result && ["green", "yellow", "red"].includes(result.rating), `stored result: ${JSON.stringify(result)}`);
  await page.close();
});

await check("no page without a privacy link gets stuck", async () => {
  const { page } = await openForm("nolink", "");
  await page.locator(BANNER).waitFor({ timeout: 15000 });
  assert((await page.locator(BANNER).innerText()).includes("doesn't link to a privacy policy"), "wrong banner");
  await page.close();
});

await check("survives the background worker being stopped mid-session", async () => {
  // Chrome stops idle service workers; results must still be there after.
  const { page } = await openForm("restart", `https://e2e-restart-${Date.now()}.example.com/privacy`);
  await page.locator(BANNER).waitFor({ timeout: 15000 });
  const cdp = await context.newCDPSession(page);
  const { targetInfos } = await cdp.send("Target.getTargets");
  const sw = targetInfos.find((t) => t.type === "service_worker" && t.url.includes("background.js"));
  await cdp.send("Target.closeTarget", { targetId: sw.targetId });
  worker = await context.waitForEvent("serviceworker", { timeout: 5000 }).catch(() => null);
  if (!worker) {
    // Wake it up the way the popup would.
    const wake = await context.newPage();
    await wake.goto(`chrome-extension://${new URL(sw.url).host}/src/popup.html`);
    worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    await wake.close();
  }
  const result = await tabResult(page);
  assert(result?.reason === "not_checked_yet", `after restart: ${JSON.stringify(result)}`);
  await page.close();
});

await check("5 reloads in a row all get a result (no dropped messages)", async () => {
  const { page, logs } = await openForm("reloads", `https://e2e-reload-${Date.now()}.example.com/privacy`);
  for (let i = 0; i < 5; i++) {
    await page.reload();
    await page.locator(BANNER).waitFor({ timeout: 15000 });
  }
  assert(!logs.some((l) => l.includes("scan request failed")), logs.find((l) => l.includes("failed")));
  await page.close();
});

await context.close();

// Separate browser, loaded from a scratch copy of the repo, so editing a file
// can't touch the real one. No phone field, so no backend requests.
// Checks the watcher notices an edit and asks Chrome to reload. (Chromium
// launched with --load-extension unloads, rather than restarts, an extension
// that reloads itself, so the restart itself can only be seen in normal
// Chrome with "Load unpacked".)
await check("dev build reloads itself when a file changes", async () => {
  const copy = mkdtempSync(join(tmpdir(), "ps-src-"));
  for (const part of ["manifest.json", "src", "icons"]) cpSync(resolve(import.meta.dirname, "..", part), join(copy, part), { recursive: true });
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "ps-e2e-")), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${copy}`, `--load-extension=${copy}`],
  });
  try {
    const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
    const reloading = new Promise((done) => sw.on("console", (m) => m.text().includes("file changed") && done()));
    await new Promise((r) => setTimeout(r, 1500)); // let the watcher take its first snapshot
    const popupCss = join(copy, "src/popup.css");
    writeFileSync(popupCss, readFileSync(popupCss, "utf8") + "\n/* edited */\n");
    const timeout = new Promise((_, fail) => setTimeout(() => fail(new Error("no reload within 5s of the edit")), 5000));
    await Promise.race([reloading, timeout]);
  } finally {
    await ctx.close();
  }
});

for (const [status, name, why] of results) console.log(`${status === "PASS" ? "✓" : "✗"} ${name}${why ? `\n    ${why}` : ""}`);
process.exit(results.some(([s]) => s === "FAIL") ? 1 : 0);
