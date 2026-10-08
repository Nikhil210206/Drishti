/**
 * The product path end to end: the built extension in Chromium, the side panel's own
 * VoiceSession and agent, ExtensionDriver on a Pathik Rail tab, and Sarvam through a running
 * proxy with a device token. A typed command (no audio), so it also runs headless.
 * Costs a few paise (one short task plus phrase translations).
 *
 *   npm run dev -w @drishti/proxy -- --port 8788      (with .dev.vars)
 *   npm run build -w @drishti/extension
 *   npx tsx apps/extension/scripts/e2e.ts ["command"] [--headed]
 */
import path from "node:path";
import { chromium } from "playwright";
import { startMockSite } from "../../dev-harness/src/mock-server.js";
import { ROOT, config } from "../../dev-harness/src/config.js";

const EXT = path.join(ROOT, "apps/extension/.output/chrome-mv3");
const PROXY = process.env.PROXY ?? "http://localhost:8788";
const command =
  process.argv.slice(2).find((a) => !a.startsWith("--")) ??
  "What trains are there from Mumbai to Pune tomorrow? Just tell me the first three.";

await startMockSite();
const home = `http://localhost:${config.mockPort}/`;
const { token } = (await (
  await fetch(`${PROXY}/v1/token`, { method: "POST", body: JSON.stringify({ turnstile: "XXXX.DUMMY.TOKEN.XXXX" }) })
).json()) as { token: string };
if (!token) throw new Error(`No token from ${PROXY}: is the proxy running with the test Turnstile secret?`);

const ctx = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: !process.argv.includes("--headed"),
  viewport: { width: 1100, height: 900 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--autoplay-policy=no-user-gesture-required"],
});
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
// Close the welcome tab a fresh install opens: it would be the tab the agent works on.
await ctx.waitForEvent("page", { timeout: 3000 }).catch(() => {});
for (const p of ctx.pages()) if (p.url().includes("welcome.html")) await p.close();
const site = ctx.pages()[0] ?? (await ctx.newPage());
await site.goto(home);
await sw.evaluate((s) => (globalThis as any).chrome.storage.local.set({ settings: s }), {
  proxyUrl: PROXY,
  token,
  homeUrl: home,
  lang: "en-IN",
  onboarded: true,
  consent: { version: "2026-10-07", at: new Date().toISOString() },
});

// The side panel page on its own (a popup window), like Chrome's panel but drivable by Playwright.
const panelOpened = ctx.waitForEvent("page");
await sw.evaluate(() =>
  (globalThis as any).chrome.windows.create({ url: (globalThis as any).chrome.runtime.getURL("sidepanel.html"), type: "popup" }),
);
const panel = await panelOpened;
const errors: string[] = [];
panel.on("console", (m) => m.type() === "error" && errors.push(m.text()));
panel.on("pageerror", (e) => errors.push(String(e)));
await panel.waitForSelector("text=Ready", { timeout: 20000 });

const t0 = Date.now();
await panel.getByLabel("Command for Drishti").fill(command);
await panel.getByLabel("Send").click();
await panel.waitForSelector("text=Working on it", { timeout: 15000 });
await panel.waitForSelector("text=Ready", { timeout: 120000 });
const reply = await panel.locator(".cap-me").innerText();
const steps = await panel.locator("ol.timeline li .step-top").allInnerTexts();
// The task's own time (the panel shows it); the rest of the wait is the reply being spoken.
const taskTime = await panel
  .locator(".task-row .muted, .muted")
  .first()
  .innerText()
  .catch(() => "?");
console.log(
  `⏱  task ${taskTime}; ${((Date.now() - t0) / 1000).toFixed(1)} s until the panel was ready again (includes speaking the reply)`,
);
console.log(`🗣  ${reply}`);
console.log(`🌐 tab now at ${site.url()}`);
console.log(
  `🪜 ${steps.length} steps: ${steps
    .map((x) => x.replace(/\s+/g, " ").trim())
    .join(" | ")
    .slice(0, 700)}`,
);
const toast = await panel
  .locator(".toast")
  .innerText({ timeout: 500 })
  .catch(() => "");
if (toast) errors.push(`shown: ${toast}`);
if (errors.length) console.log(`⚠️  panel errors:\n${errors.join("\n")}`);
await ctx.close();
process.exit(0);
