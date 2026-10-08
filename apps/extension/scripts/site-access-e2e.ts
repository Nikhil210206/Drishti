/**
 * Site access in the real extension: Pathik Rail served as http://practice.test:5174 (Chrome maps
 * the name to localhost), a site the extension has no access to. The panel must ask before the
 * agent touches it, and on a no end the task quietly without reading or touching the page.
 * Chrome's own Allow box can't be pressed by automation, so the yes path is a manual check.
 *
 *   npm run dev -w @drishti/proxy -- --port 8788
 *   npm run build -w @drishti/extension
 *   npx tsx apps/extension/scripts/site-access-e2e.ts [--headed]
 */
import path from "node:path";
import { chromium } from "playwright";
import { startMockSite } from "../../dev-harness/src/mock-server.js";
import { ROOT, config } from "../../dev-harness/src/config.js";

const EXT = path.join(ROOT, "apps/extension/.output/chrome-mv3");
const PROXY = process.env.PROXY ?? "http://localhost:8788";
const ok = (name: string, pass: boolean, detail = "") => {
  console.log(`${pass ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!pass) process.exitCode = 1;
};

await startMockSite();
const site = `http://practice.test:${config.mockPort}/`;
const { token } = (await (
  await fetch(`${PROXY}/v1/token`, { method: "POST", body: JSON.stringify({ turnstile: "XXXX.DUMMY.TOKEN.XXXX" }) })
).json()) as { token: string };

const ctx = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: !process.argv.includes("--headed"),
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    "--host-resolver-rules=MAP practice.test 127.0.0.1",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
try {
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  // Close the welcome tab a fresh install opens; this test starts already set up.
  await ctx.waitForEvent("page", { timeout: 3000 }).catch(() => {});
  for (const p of ctx.pages()) if (p.url().includes("welcome.html")) await p.close();
  await sw.evaluate((s) => (globalThis as any).chrome.storage.local.set({ settings: s }), {
    proxyUrl: PROXY,
    token,
    lang: "en-IN",
    homeUrl: site,
    speaker: "kavya",
    pace: 1.1,
    onboarded: true,
    consent: { version: "2026-10-07", at: new Date().toISOString() },
  });
  const tab = ctx.pages()[0] ?? (await ctx.newPage());
  await tab.goto(site);
  const fingerprint = await tab.evaluate(() => document.querySelectorAll("[data-drishti-id]").length);

  const panelOpened = ctx.waitForEvent("page");
  await sw.evaluate(() =>
    (globalThis as any).chrome.windows.create({ url: (globalThis as any).chrome.runtime.getURL("sidepanel.html"), type: "popup" }),
  );
  const panel = await panelOpened;
  await panel.getByLabel("Command for Drishti").waitFor({ timeout: 20000 });

  await panel.getByLabel("Command for Drishti").fill("What is on this page?");
  await panel.getByLabel("Send").click();
  const dialog = panel.getByRole("alertdialog");
  await dialog.waitFor({ timeout: 15000 });
  const question = await dialog.innerText();
  ok(
    "asks before working on a new site",
    /practice\.test: Drishti needs your permission/.test(question),
    question.replace(/\s+/g, " ").slice(0, 110),
  );

  await panel.locator(".btn.no").click();
  // The task ends at once; the reply is spoken just after.
  await panel
    .locator(".cap-me", { hasText: /won't work/ })
    .waitFor({ timeout: 15000 })
    .catch(() => {});
  const reply = await panel.locator(".cap-me").innerText();
  ok("a no ends the task politely", /won't work on this website/.test(reply), reply);
  const touched = await tab.evaluate(() => document.querySelectorAll("[data-drishti-id]").length);
  ok("the page was not read or touched", touched === fingerprint && touched === 0, `${touched} elements tagged`);
  const sites = await sw.evaluate(
    async () => ((await (globalThis as any).chrome.storage.local.get("settings")).settings?.sites ?? []) as string[],
  );
  ok("nothing remembered as allowed", sites.length === 0);

  // A new request asks again. Pressing Yes must reach Chrome as a user gesture: Chrome then shows
  // its own Allow box (which automation can't press) instead of Drishti asking for the button.
  await panel.getByLabel("Command for Drishti").fill("What is on this page?");
  await panel.getByLabel("Send").click();
  await dialog.waitFor({ timeout: 15000 });
  ok("a new request asks again", true);
  await panel.locator(".btn.yes").click();
  await panel.waitForTimeout(4000);
  const after = await panel.locator(".cap-me").innerText();
  ok("pressing Yes reaches Chrome as a user gesture", !/needs a key press/.test(after), after.slice(0, 90));
} finally {
  await ctx.close();
}
process.exit();
