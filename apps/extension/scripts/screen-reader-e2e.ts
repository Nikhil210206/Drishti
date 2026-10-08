/**
 * Screen-reader mode and the global shortcuts in the real extension:
 *
 * - replies go to the panel's one live region (in their language) and Bulbul is never called;
 * - nothing else in the panel is a live region (no chatter over Bulbul or into the microphone);
 * - a confirmation takes focus on the dialog, not on its Yes button, unless the user is in the
 *   command box: then it is announced, and a "y" typed there doesn't answer it;
 * - the shortcuts (delivered as Chrome would, through the background) talk, answer and stop;
 * - the Yes shortcut on "may Drishti work on this site?" reaches the background's request;
 * - switching back to Drishti's voice is remembered.
 *
 * No `--autoplay-policy` flag here: it checks that a shortcut can start the microphone in a panel
 * nobody has clicked. Costs a fraction of a paisa (a few seconds of STT, one short TTS reply).
 *
 *   npm run dev -w @drishti/proxy -- --port 8788
 *   npm run build -w @drishti/extension
 *   npx tsx apps/extension/scripts/screen-reader-e2e.ts [--headed]
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
const home = `http://localhost:${config.mockPort}/`;
const newSite = `http://practice.test:${config.mockPort}/`;
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
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
  ],
});
try {
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  await ctx.waitForEvent("page", { timeout: 3000 }).catch(() => {});
  for (const p of ctx.pages()) if (p.url().includes("welcome.html")) await p.close();
  const settings = () => sw.evaluate(async () => (await (globalThis as any).chrome.storage.local.get("settings")).settings);
  await sw.evaluate((s) => (globalThis as any).chrome.storage.local.set({ settings: s }), {
    proxyUrl: PROXY,
    token,
    lang: "en-IN",
    homeUrl: home,
    speaker: "kavya",
    pace: 1.1,
    output: "screenreader",
    onboarded: true,
    profile: { name: "Asha Verma (test)" },
    consent: { version: "2026-10-07", at: new Date().toISOString() },
  });
  const tab = ctx.pages()[0] ?? (await ctx.newPage());
  await tab.goto(home);
  const windowId = await sw.evaluate(
    async () => (await (globalThis as any).chrome.windows.getAll({ windowTypes: ["normal"] }))[0].id as number,
  );
  const command = (c: string) => sw.evaluate(([name, w]) => (globalThis as any).drishtiTest.command(name, w), [c, windowId] as const);

  const panelOpened = ctx.waitForEvent("page");
  await sw.evaluate(() =>
    (globalThis as any).chrome.windows.create({ url: (globalThis as any).chrome.runtime.getURL("sidepanel.html"), type: "popup" }),
  );
  const panel = await panelOpened;
  const sockets: string[] = [];
  panel.on("websocket", (ws) => sockets.push(ws.url()));
  await panel.getByLabel("Command for Drishti").waitFor({ timeout: 20000 });
  let current = panel;
  const announced = () => current.locator(".sr-only[aria-live]");
  const waitAnnounced = async (re: RegExp, ms = 15000) => {
    await current.waitForFunction(
      (src) => new RegExp(src).test(document.querySelector(".sr-only[aria-live]")?.textContent ?? ""),
      re.source,
      {
        timeout: ms,
      },
    );
    return (await announced().textContent()) ?? "";
  };

  // 1. The shortcuts as Chrome has them, shown in the panel.
  ok(
    "shortcut hint shows Chrome's key",
    await panel.getByText(/talk from any page/).isVisible(),
    await panel.locator(".hints").innerText(),
  );

  // 2. A reply goes to the live region, in its language, and Bulbul is never asked.
  await panel.getByLabel("Settings").click();
  await panel.getByRole("button", { name: "Say hello" }).click();
  const hello = await waitAnnounced(/Drishti/);
  ok("reply is announced to the screen reader", /Hi, I'm Drishti/.test(hello), hello);
  ok("in its language", (await announced().getAttribute("lang")) === "en-IN");
  await panel.waitForTimeout(1000);
  ok("Bulbul is not called", !sockets.some((u) => u.includes("text-to-speech")), sockets.join(", ") || "no sockets");
  const live = await panel.evaluate(() => [...document.querySelectorAll("[aria-live]")].map((e) => e.className));
  ok("the announcer is the only live region", live.length === 1, live.join(", "));
  await panel.getByLabel("Close settings").click();

  // 3. The talk shortcut starts listening in a panel nobody clicked since it opened... (the clicks
  // above count, so reopen the panel fresh first).
  await panel.close();
  const fresh = ctx.waitForEvent("page");
  await sw.evaluate(() =>
    (globalThis as any).chrome.windows.create({ url: (globalThis as any).chrome.runtime.getURL("sidepanel.html"), type: "popup" }),
  );
  const p2 = await fresh;
  current = p2;
  const p2Sockets: string[] = [];
  p2.on("websocket", (ws) => p2Sockets.push(ws.url()));
  await p2.getByLabel("Command for Drishti").waitFor({ timeout: 20000 });
  await p2.waitForTimeout(500);
  await command("talk");
  const orb = p2.locator(".orb");
  await p2
    .waitForFunction(() => document.querySelector(".orb")?.getAttribute("aria-pressed") === "true", null, { timeout: 8000 })
    .catch(() => {});
  const pressed = await orb.getAttribute("aria-pressed");
  const held = await p2
    .locator(".toast")
    .innerText({ timeout: 500 })
    .catch(() => "");
  ok("talk shortcut starts listening", pressed === "true", held || `orb ${await orb.getAttribute("aria-label")}`);
  await p2.waitForTimeout(2500);
  ok(
    "…and streams to Saaras",
    p2Sockets.some((u) => u.includes("speech-to-text")),
  );
  await command("talk");
  await p2
    .waitForFunction(() => document.querySelector(".orb")?.getAttribute("aria-pressed") === "false", null, { timeout: 5000 })
    .catch(() => {});
  ok("talk shortcut again stops listening", (await orb.getAttribute("aria-pressed")) === "false");

  // 4. A confirmation while the user is in the command box: focus stays there (a "y" they type
  // must not answer it) and the question is announced. The No shortcut declines.
  await p2.bringToFront();
  const box = p2.getByLabel("Command for Drishti");
  const inBox = () => p2.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Command for Drishti");
  await box.fill("delete my details");
  await box.press("Enter");
  await p2.getByRole("alertdialog").waitFor({ timeout: 10000 });
  const asked = await waitAnnounced(/Delete your saved/);
  ok("a confirmation leaves focus in the command box and is announced", await inBox(), asked);
  await p2.keyboard.type("my train");
  await p2.waitForTimeout(1000);
  ok(
    "typing in the box doesn't answer it",
    (await p2.getByRole("alertdialog").isVisible()) && !!(await settings()).profile,
    `box: ${await box.inputValue()}`,
  );
  await command("no");
  await waitAnnounced(/not done it/);
  await box.fill("");

  // …anywhere else it takes focus on the dialog (its question read with it), not on Yes; the Yes shortcut answers.
  await box.fill("delete my details");
  await p2.getByLabel("Send").click();
  await p2.getByRole("alertdialog").waitFor({ timeout: 10000 });
  await p2.waitForTimeout(300);
  const focus = await p2.evaluate(() => ({
    role: document.activeElement?.getAttribute("role"),
    desc: document.getElementById(document.activeElement?.getAttribute("aria-describedby") ?? "")?.textContent,
    hasFocus: document.hasFocus(),
  }));
  ok("confirmation takes focus on the dialog, not Yes", focus.role === "alertdialog", JSON.stringify(focus));
  await command("yes");
  const forgotten = await waitAnnounced(/deleted/);
  ok("Yes shortcut answers the confirmation", !(await settings()).profile, forgotten);
  ok("focus returns to the command box", await inBox());

  // 5. A new site. The Yes shortcut asks Chrome for it from the background, inside the key press.
  // A real press is a gesture; this test's isn't, so Chrome refuses and the panel's own fallback
  // asks for a key press (after waiting out the gesture the Enter above gave the panel).
  // The No shortcut then ends it.
  await tab.goto(newSite);
  await p2.getByLabel("Command for Drishti").fill("What is on this page?");
  await p2.getByLabel("Command for Drishti").press("Enter");
  await p2.getByRole("alertdialog").waitFor({ timeout: 15000 });
  const siteQ = await waitAnnounced(/needs your permission/);
  ok("site question is announced, focus left in the command box", await inBox(), siteQ.slice(0, 80));
  await p2.waitForTimeout(5500);
  await command("yes");
  const press = await waitAnnounced(/key press/);
  const requests = await sw.evaluate(() => (globalThis as any).drishtiTest.siteRequests as string[][]);
  ok(
    "Yes shortcut asks Chrome for the site from the background",
    requests[0]?.[0] === "https://*.practice.test/*",
    requests.map((r) => r[0]).join(" → "),
  );
  ok("without a gesture, Drishti asks for a key press and names the shortcut", /Alt Shift Y/.test(press), press);
  await command("no");
  const denied = await waitAnnounced(/won't work/);
  ok("No shortcut declines", true, denied);

  // 6. Back to Drishti's voice: remembered, and Bulbul speaks again while the live region stays quiet.
  await p2.getByLabel("Settings").click();
  await p2.getByLabel("Replies").selectOption("voice");
  await p2.waitForTimeout(500);
  ok("switching to Drishti's voice is remembered", (await settings()).output === "voice");
  const before = (await p2.locator(".sr-only[aria-live]").textContent()) ?? "";
  await p2.getByRole("button", { name: "Say hello" }).click();
  await p2.waitForTimeout(3000);
  ok(
    "Bulbul speaks in voice mode",
    p2Sockets.some((u) => u.includes("text-to-speech")),
  );
  ok("…and the live region stays quiet", ((await p2.locator(".sr-only[aria-live]").textContent()) ?? "") === before);
} finally {
  await ctx.close();
}
process.exit();
