/**
 * Phase 2 exit check, the automated half: the release build in Chromium, talking to the deployed
 * proxy and website. (The other half is your own Chrome profile: docs/phase-2.md, step 8.)
 *
 *   1. A Pathik Rail booking on the website's practice copy, with every question answered in the
 *      panel the way a user would (Yes to the confirmations).
 *   2. Reading a real HTTPS page, the website's privacy page: Readability, the LLM and Bulbul,
 *      all through the deployed proxy.
 *
 *   npm run build:release -w @drishti/extension
 *   TOKEN=$(npx tsx apps/proxy/scripts/mint.ts) npx tsx apps/extension/scripts/exit-check.ts [--headed]
 *
 * Costs a few rupees: two tasks through the proxy, spoken by Bulbul.
 */
import path from "node:path";
import { chromium, type Page } from "playwright";
import { ROOT } from "../../dev-harness/src/config.js";

const EXT = path.join(ROOT, "apps/extension/.output/chrome-mv3-release");
const WEBSITE = "https://drishti-voice.pages.dev";
const PROXY_HOST = "drishti-proxy.nikhil-drishti.workers.dev";
const TOKEN = process.env.TOKEN;
if (!TOKEN) throw new Error("Set TOKEN to a device token for the deployed proxy: npx tsx apps/proxy/scripts/mint.ts");
const ok = (name: string, pass: boolean, detail = "") => {
  console.log(`${pass ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!pass) process.exitCode = 1;
};

const ctx = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: !process.argv.includes("--headed"),
  viewport: { width: 1100, height: 900 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
try {
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  // A fresh install opens the welcome tab; this check starts already set up.
  await ctx.waitForEvent("page", { timeout: 3000 }).catch(() => {});
  for (const p of ctx.pages()) if (p.url().includes("welcome.html")) await p.close();
  await sw.evaluate((s) => (globalThis as any).chrome.storage.local.set({ settings: s }), {
    token: TOKEN,
    lang: "en-IN",
    onboarded: true,
    consent: { version: "2026-10-07", at: new Date().toISOString() },
    profile: { name: "Asha Verma", age: "34", gender: "Female", mobile: "9000000001" },
  });
  const site = ctx.pages()[0] ?? (await ctx.newPage());
  await site.goto(`${WEBSITE}/practice/`);

  const opened = ctx.waitForEvent("page");
  await sw.evaluate(() =>
    (globalThis as any).chrome.windows.create({ url: (globalThis as any).chrome.runtime.getURL("sidepanel.html"), type: "popup" }),
  );
  const panel = await opened;
  const errors: string[] = [];
  panel.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  panel.on("pageerror", (e) => errors.push(String(e)));
  const sockets: string[] = [];
  panel.on("websocket", (ws) => sockets.push(new URL(ws.url()).host));
  await panel.getByLabel("Command for Drishti").waitFor({ timeout: 20000 });

  // ---- 1. A booking on the practice site ----
  const t0 = Date.now();
  const asked = await runTask(panel, "Book a sleeper class ticket from Chennai to Bengaluru tomorrow for me.");
  const booked = /#\/done\?pnr=\d+/.test(site.url());
  const page = await site
    .locator("#app")
    .innerText()
    .catch(() => "");
  ok("booking on the practice site", booked, `${((Date.now() - t0) / 1000).toFixed(0)} s; ${site.url().replace(WEBSITE, "")}`);
  ok(
    "…confirmed by the user first",
    asked.some((q) => /₹|pay|book/i.test(q)),
    asked.map((q) => `"${q.slice(0, 90)}"`).join(" · "),
  );
  if (booked) console.log(`   ${page.replace(/\s+/g, " ").slice(0, 200)}`);

  // ---- 2. Reading a real HTTPS page ----
  await site.goto(`${WEBSITE}/privacy.html`);
  const t1 = Date.now();
  await runTask(panel, "What does this page say? Tell me in two sentences.");
  const reply = await panel.locator(".cap-me").innerText();
  ok(
    "reading a real page",
    /Sarvam|data|device|details/i.test(reply),
    `${((Date.now() - t1) / 1000).toFixed(0)} s; "${reply.slice(0, 160)}"`,
  );

  // ---- through the deployed proxy only ----
  const hosts = [...new Set(sockets)];
  ok("speech went through the deployed proxy", hosts.length > 0 && hosts.every((h) => h === PROXY_HOST), hosts.join(", "));
  const cost = await panel.locator(".cost").innerText();
  const toast = await panel
    .locator(".toast")
    .innerText({ timeout: 500 })
    .catch(() => "");
  if (toast) errors.push(`shown: ${toast}`);
  ok("no errors in the panel", !errors.length, errors.join(" | ").slice(0, 300) || cost);
} finally {
  await ctx.close();
}
process.exit();

/** Send a typed command and answer what Drishti asks, until the task ends. Returns the questions. */
async function runTask(panel: Page, command: string): Promise<string[]> {
  const asked: string[] = [];
  const box = panel.getByLabel("Command for Drishti");
  const label = () => panel.locator(".state-label").innerText();
  await box.fill(command);
  await box.press("Enter");
  try {
    await panel.waitForSelector("text=Working on it", { timeout: 20000 });
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      const dialog = panel.getByRole("alertdialog");
      if (await dialog.isVisible().catch(() => false)) {
        const q = (await dialog.locator("#prompt-q").innerText()).trim();
        if (q !== asked.at(-1)) {
          asked.push(q);
          // A confirmation: Yes, as the user. A question: the first option.
          if (await dialog.locator(".btn.yes").isVisible()) await dialog.locator(".btn.yes").click();
          else {
            await box.fill("The first one, please.");
            await box.press("Enter");
          }
        }
      } else if ((await label()).startsWith("Ready")) {
        // Finished and the reply spoken (the label says "Speaking" until then).
        return asked;
      }
      await panel.waitForTimeout(400);
    }
    throw new Error("did not finish in 4 minutes");
  } catch (e) {
    const toast = await panel
      .locator(".toast")
      .innerText({ timeout: 500 })
      .catch(() => "");
    const steps = await panel.locator("ol.timeline li .step-top").allInnerTexts();
    throw new Error(
      `"${command}": ${(e as Error).message.split("\n")[0]}\n  panel: ${await label()}\n  said: ${await panel.locator(".cap-me").innerText()}\n  steps: ${steps.join(" | ").replace(/\s+/g, " ")}\n  toast: ${toast}`,
    );
  }
}
