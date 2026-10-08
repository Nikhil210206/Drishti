/**
 * The welcome flow end to end, on a fresh install: language → connect (the real website page,
 * Turnstile's always-pass test key, the proxy) → privacy → microphone (Chrome's fake device,
 * fed from a recorded Tamil clip) → replies by voice or screen reader → voice sample → details → practice. Then, in the side panel,
 * "मेरी जानकारी मिटा दो" deletes the saved details after a spoken yes. Costs a few paise.
 *
 *   npm run dev -w @drishti/proxy -- --port 8788   (with .dev.vars)
 *   npm run build -w @drishti/extension
 *   npx tsx apps/extension/scripts/onboarding-e2e.ts [--headed]
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { startMockSite } from "../../dev-harness/src/mock-server.js";
import { ROOT } from "../../dev-harness/src/config.js";

const EXT = path.join(ROOT, "apps/extension/.output/chrome-mv3");
const CLIP = path.join(ROOT, "cache/spike-ta.wav");
const ok = (name: string, pass: boolean, detail = "") => {
  console.log(`${pass ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!pass) process.exitCode = 1;
};

await startMockSite();
const website = spawn("npx", ["tsx", "apps/website/scripts/serve.ts"], { cwd: ROOT, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1500));

const ctx = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: !process.argv.includes("--headed"),
  viewport: { width: 1100, height: 900 },
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${CLIP}`,
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
const storage = () => sw.evaluate(async () => ((await (globalThis as any).chrome.storage.local.get("settings")).settings ?? {}) as any);

try {
  // A fresh install opens the welcome page by itself.
  const welcome: Page =
    ctx.pages().find((p) => p.url().endsWith("/welcome.html")) ??
    (await ctx.waitForEvent("page", { predicate: (p) => p.url().endsWith("/welcome.html"), timeout: 10000 }));
  ok("welcome opens on install", true);
  const logs: string[] = [];
  welcome.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`));
  welcome.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));

  await welcome.getByRole("button", { name: /हिन्दी/ }).click();
  await welcome.getByRole("heading", { name: "Drishti जोड़िए" }).waitFor();
  ok("language chosen, connect step in Hindi", true);

  // Connect: the website's page runs Turnstile and hands the token to the extension.
  const connectOpened = ctx.waitForEvent("page");
  await welcome.getByRole("button", { name: "जोड़िए" }).click();
  const connect = await connectOpened;
  await welcome.getByRole("heading", { name: "आपकी निजता" }).waitFor({ timeout: 30000 });
  ok("connected through the website", !!(await storage()).token, connect.url().split("?")[0]);

  await welcome.getByRole("button", { name: "मैं सहमत हूँ" }).click();
  await welcome.getByRole("heading", { name: "आपका माइक्रोफ़ोन" }).waitFor();
  ok("consent recorded", !!(await storage()).consent?.version);

  // Microphone: allow (the fake prompt accepts), then hold to test while the clip plays.
  await welcome.getByRole("button", { name: "माइक्रोफ़ोन की अनुमति दीजिए" }).click();
  const hold = welcome.getByRole("button", { name: "टेस्ट के लिए दबाकर रखिए" });
  await hold.waitFor();
  await hold.focus();
  await welcome.keyboard.down(" ");
  await welcome.waitForTimeout(6000);
  await welcome.keyboard.up(" ");
  const heard = await welcome
    .getByText("मैंने सुना:")
    .locator("strong")
    .innerText({ timeout: 15000 })
    .catch(() => "");
  ok("microphone test heard speech", !!heard, heard.slice(0, 60) || logs.slice(-8).join(" | "));
  await welcome.getByRole("button", { name: "आगे" }).click();

  await welcome.getByRole("heading", { name: "Drishti की आवाज़" }).waitFor();
  await welcome.getByLabel(/मेरा स्क्रीन रीडर/).click();
  await welcome.waitForTimeout(300);
  ok("screen-reader replies can be chosen", (await storage()).output === "screenreader");
  await welcome.getByLabel(/Drishti की अपनी आवाज़/).click();
  await welcome.getByRole("combobox").selectOption("shubh"); // the voice list
  await welcome.getByRole("button", { name: "नमूना सुनिए" }).click();
  await welcome.waitForTimeout(1500);
  await welcome.getByRole("button", { name: "आगे" }).click();
  ok("voice chosen", (await storage()).speaker === "shubh");

  await welcome.getByLabel("नाम").fill("Asha Verma (test)");
  await welcome.getByLabel("उम्र").fill("34");
  await welcome.getByRole("button", { name: "सेव कीजिए" }).click();
  await welcome.getByRole("heading", { name: "आज़माइए" }).waitFor();
  ok("details saved on the device", (await storage()).profile?.name === "Asha Verma (test)");

  await welcome.getByRole("button", { name: "अभ्यास शुरू कीजिए" }).click();
  await welcome.waitForURL(/localhost:5174/, { timeout: 10000 });
  ok("practice site opens", (await storage()).onboarded === true, welcome.url());

  // The side panel (opened as its own page here) is ready, and deletes the details on request.
  const panelOpened = ctx.waitForEvent("page");
  await sw.evaluate(() =>
    (globalThis as any).chrome.windows.create({ url: (globalThis as any).chrome.runtime.getURL("sidepanel.html"), type: "popup" }),
  );
  const panel = await panelOpened;
  await panel.getByLabel("Command for Drishti").waitFor({ timeout: 20000 });
  await panel.getByLabel("Command for Drishti").fill("मेरी जानकारी मिटा दो");
  await panel.getByLabel("Send").click();
  await panel.getByRole("alertdialog").waitFor({ timeout: 15000 });
  await panel.locator(".btn.yes").click();
  await panel.waitForTimeout(1500);
  ok("'delete my details' wiped the profile after a yes", !(await storage()).profile);
} finally {
  await ctx.close();
  website.kill();
}
process.exit();
