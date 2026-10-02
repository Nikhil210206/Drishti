/**
 * Phase 0 spikes 1, 3 and 4, driven through the unpacked spike extension in Chromium.
 *   npx tsx spikes/extension/run.ts [snapshot|actions|mic|all]
 * Writes spikes/extension/results/*.json. Set HEADED=1 to watch.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { chromium, type Page, type Worker } from "playwright";
import { startMockSite } from "../../apps/dev-harness/src/mock-server.js";
import { SNAPSHOT_FN } from "../../apps/dev-harness/src/playwright-driver.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(here, "ext");
const OUT = path.join(here, "results");
fs.mkdirSync(OUT, { recursive: true });
fs.copyFileSync(path.join(here, "../../packages/core/src/snapshot.js"), path.join(EXT, "snapshot.js"));
const which = process.argv[2] ?? "all";

// ---------- local fixtures ----------
const mock = await startMockSite(5174);
// A page with a same-origin and a cross-origin iframe (localhost vs 127.0.0.1 are different origins).
const frames = Fastify();
frames.get("/outer", async (_req, reply) =>
  reply.type("text/html").send(`<!doctype html><title>Frames</title><h1>Outer page</h1><button>Outer button</button>
    <iframe src="http://localhost:5175/inner?who=same" width="400" height="120"></iframe>
    <iframe src="http://127.0.0.1:5175/inner?who=cross" width="400" height="120"></iframe>`),
);
frames.get("/inner", async (req, reply) => {
  const who = (req.query as any).who;
  return reply
    .type("text/html")
    .send(
      `<!doctype html><title>Inner ${who}</title><p>Inside ${who} frame</p><button>${who} frame button</button><input placeholder="${who} field">`,
    );
});
await frames.listen({ port: 5175, host: "0.0.0.0" });

// ---------- browser with the extension ----------
async function launch(extraArgs: string[] = []) {
  const ctx = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: process.env.HEADED !== "1",
    viewport: { width: 1280, height: 900 },
    locale: "en-IN",
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, ...extraArgs],
  });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  return { ctx, sw };
}

async function tabIdOf(sw: Worker, page: Page): Promise<number> {
  await page.bringToFront();
  return sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].id!);
}

const settle = (page: Page, ms = 2500) => page.waitForLoadState("domcontentloaded").then(() => page.waitForTimeout(ms));

// ---------- spike 3: snapshot via chrome.scripting ----------
const SITES = [
  { name: "Pathik Rail (mock)", url: "http://localhost:5174/" },
  { name: "Frames fixture (same + cross-origin iframe)", url: "http://localhost:5175/outer" },
  { name: "Hindi Wikipedia article", url: "https://hi.wikipedia.org/wiki/%E0%A4%AD%E0%A4%BE%E0%A4%B0%E0%A4%A4" },
  { name: "IRCTC train search", url: "https://www.irctc.co.in/nget/train-search" },
  { name: "National Portal of India", url: "https://www.india.gov.in/" },
  { name: "myScheme", url: "https://www.myscheme.gov.in/" },
  { name: "BBC Hindi", url: "https://www.bbc.com/hindi" },
];

async function snapshotSpike() {
  const { ctx, sw } = await launch();
  const rows: any[] = [];
  for (const site of SITES.filter((x) => !process.env.ONLY || x.name.includes(process.env.ONLY))) {
    const page = await ctx.newPage();
    const row: any = { site: site.name, url: site.url };
    try {
      const resp = await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      row.http = resp?.status();
      await settle(page, 4000);
      row.finalUrl = page.url();
      const tabId = await tabIdOf(sw, page);
      const ext: any = await sw.evaluate(({ tabId }) => (self as any).drishti.snapshotAll(tabId), { tabId });
      const t0 = Date.now();
      const pw: any = await page.evaluate(`(${SNAPSHOT_FN})({})`);
      row.playwrightMs = Date.now() - t0;
      row.extensionMs = ext.ms;
      row.frameCount = ext.frameCount;
      row.frames = ext.frames;
      row.mainChars = ext.main?.text.length ?? 0;
      row.mainElements = ext.main ? Object.keys(ext.main.elements).length : 0;
      row.playwrightChars = pw.text.length;
      row.playwrightElements = Object.keys(pw.elements).length;
      row.sameAsPlaywright = ext.main?.text === pw.text;
      row.framesWithContent = ext.frames.filter((f: any) => f.frameId !== 0 && f.elements > 0).length;
      row.frameErrors = ext.frames.filter((f: any) => f.error).map((f: any) => f.error);
      row.preview = (ext.main?.text ?? "").split("\n").slice(0, 25).join("\n");
      row.dialog = ext.main?.dialog ?? "";
      row.inferred = (ext.main?.text.match(/\(inferred\)/g) ?? []).length;
      row.colour = (ext.main?.text.match(/\(colour: /g) ?? []).length;
    } catch (e: any) {
      row.error = String(e?.message ?? e).split("\n")[0];
    }
    console.log(
      `${row.error ? "❌" : "✅"} ${site.name}: ${row.error ?? `${row.mainElements} elements, ${row.mainChars} chars, ${row.frames?.length} frames injected (${row.framesWithContent} with content), ext ${row.extensionMs} ms`}`,
    );
    rows.push(row);
    await page.close();
  }
  fs.writeFileSync(
    path.join(
      OUT,
      `snapshot${process.env.HEADED === "1" ? "-headed" : ""}${process.env.ONLY ? "-" + process.env.ONLY.replace(/\W+/g, "") : ""}.json`,
    ),
    JSON.stringify(rows, null, 2),
  );
  await ctx.close();
}

// ---------- spike 4: synthetic vs debugger input ----------
type Mode = "synthetic" | "debugger" | "debugger-keys";

async function actionsSpike() {
  const out: any[] = [];
  const modes = (process.env.MODES?.split(",") ?? ["synthetic", "debugger", "debugger-keys"]) as Mode[];
  for (const mode of modes) {
    const { ctx, sw } = await launch();
    const api = (fn: string, ...args: any[]) => sw.evaluate(({ fn, args }) => (self as any).drishti[fn](...args), { fn, args });
    let maxElements = 220;
    const snap = async (tabId: number) => (await api("snapshot", tabId, 0, { maxElements })) as any;
    const find = (s: any, pred: (e: any) => boolean) => Object.entries(s.elements).find(([, e]) => pred(e))?.[0];
    const names = (s: any) => Object.values(s.elements).map((e: any) => e.name as string);

    const record = (site: string, step: string, ok: boolean, detail = "") => {
      out.push({ mode, site, step, ok, detail });
      console.log(`${ok ? "✅" : "❌"} [${mode}] ${site}: ${step}${detail ? ` — ${detail}` : ""}`);
    };

    // Pathik Rail: autocomplete (input/keyup), div buttons with onclick, calendar chips, hash routing.
    {
      const page = await ctx.newPage();
      await page.goto("http://localhost:5174/");
      await settle(page, 800);
      const tab = await tabIdOf(sw, page);
      try {
        let s = await snap(tab);
        await api(
          "type",
          tab,
          0,
          find(s, (e) => e.name === "FROM"),
          "Chennai",
          mode,
        );
        await page.waitForTimeout(500);
        s = await snap(tab);
        const sugg = find(s, (e) => /Chennai Central/.test(e.name));
        record("Pathik Rail", "type FROM shows suggestions", !!sugg);
        if (sugg) await api("click", tab, 0, sugg, mode);
        await page.waitForTimeout(300);
        s = await snap(tab);
        record(
          "Pathik Rail",
          "click suggestion fills FROM",
          /MAS|Chennai Central/.test(
            String(
              await api(
                "value",
                tab,
                0,
                find(s, (e) => e.name === "FROM"),
              ),
            ),
          ),
        );
        await api(
          "type",
          tab,
          0,
          find(s, (e) => e.name === "TO"),
          "Bengaluru",
          mode,
        );
        await page.waitForTimeout(500);
        s = await snap(tab);
        const sugg2 = find(s, (e) => /KSR Bengaluru/.test(e.name));
        if (sugg2) await api("click", tab, 0, sugg2, mode);
        await page.waitForTimeout(300);
        s = await snap(tab);
        await api(
          "click",
          tab,
          0,
          find(s, (e) => e.name === "Tomorrow"),
          mode,
        );
        await page.waitForTimeout(300);
        s = await snap(tab);
        await api(
          "click",
          tab,
          0,
          find(s, (e) => /SEARCH TRAINS/.test(e.name)),
          mode,
        );
        await page.waitForTimeout(800);
        record("Pathik Rail", "search reaches results page", page.url().includes("#/results"), page.url().replace(/^.*#/, "#"));
        s = await snap(tab);
        await api(
          "click",
          tab,
          0,
          find(s, (e) => e.name === "book ticket"),
          mode,
        );
        await page.waitForTimeout(600);
        s = await snap(tab);
        const name = find(s, (e) => e.name === "Name" && e.role === "textbox");
        await api("type", tab, 0, name, "Asha Verma", mode);
        await page.waitForTimeout(200);
        const stored = await page.evaluate(() => JSON.stringify(sessionStorage));
        record("Pathik Rail", "typed passenger name reaches app state", stored.includes("Asha Verma"));
      } catch (e: any) {
        record("Pathik Rail", "flow", false, String(e?.message ?? e).split("\n")[0]);
      }
      await page.close();
    }

    // Real sites: does typing reach the site's own handlers (suggestions appear)?
    const real = [
      {
        site: "Hindi Wikipedia search",
        url: "https://hi.wikipedia.org/wiki/",
        box: (e: any) => /खोज|search/i.test(e.name) && /textbox|searchbox/.test(e.role),
        query: "भारत",
      },
      {
        site: "myScheme search",
        url: "https://www.myscheme.gov.in/",
        box: (e: any) => /search/i.test(e.name) && /textbox|searchbox|combobox/.test(e.role),
        query: "scholarship",
      },
      {
        site: "IRCTC From station",
        url: "https://www.irctc.co.in/nget/train-search",
        box: (e: any) => /from/i.test(e.name) && /textbox|combobox|searchbox/.test(e.role),
        query: "CHENNAI",
      },
    ];
    for (const r of real.filter((x) => !process.env.ONLY || x.site.includes(process.env.ONLY))) {
      const page = await ctx.newPage();
      maxElements = 220;
      try {
        await page.goto(r.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await settle(page, 4000);
        const tab = await tabIdOf(sw, page);
        let s = await snap(tab);
        // Dismiss a blocking alert (IRCTC's language/Aadhaar notice) the way the agent would: click its button.
        if (s.dialog) {
          const ok = find(s, (e) => e.role === "button");
          if (ok) await api("click", tab, 0, ok, mode);
          await page.waitForTimeout(1500);
          s = await snap(tab);
          record(r.site, "dismiss blocking dialog", !s.dialog, `dialog now "${s.dialog}"`);
        }
        let box = find(s, r.box);
        // A search "box" that is really a button revealing the input (myScheme).
        const opener = !box && find(s, (e) => /search/i.test(e.name) && e.role === "clickable");
        if (opener) {
          await api("click", tab, 0, opener, mode);
          await page.waitForTimeout(1500);
          s = await snap(tab);
          box = find(s, r.box);
          record(r.site, "click search opener reveals input", !!box);
        }
        // Element budget spent before the form (IRCTC nav menus): try a bigger budget.
        if (!box && Object.keys(s.elements).length >= maxElements) {
          maxElements = 800;
          s = await snap(tab);
          box = find(s, r.box);
          record(r.site, "box only found with a bigger element budget", !!box, `${Object.keys(s.elements).length} elements`);
        }
        if (!box) {
          const near = Object.values(s.elements)
            .filter((e: any) => /search|from|से|input/i.test(`${e.name} ${e.fieldHint} ${e.tag}`))
            .slice(0, 8)
            .map((e: any) => `${e.role}/${e.tag}/${e.type} "${e.name}" hint="${e.fieldHint}"`);
          record(r.site, "find search box", false, `no matching box; candidates: ${near.join(" | ")}`);
          await page.close();
          continue;
        }
        const beforeIds = new Set(Object.keys(s.elements));
        await api("type", tab, 0, box, r.query, mode);
        await page.waitForTimeout(2500);
        s = await snap(tab);
        // Widgets may re-render the input; read the value from whichever box matches now.
        const value = await api("value", tab, 0, find(s, r.box) ?? box);
        const fresh = Object.entries(s.elements).filter(
          ([id, e]: [string, any]) => !beforeIds.has(id) && /option|link|clickable|button/.test(e.role),
        );
        record(r.site, "value set", value === r.query, `value="${value}"`);
        const domOptions = await page.evaluate(() => document.querySelectorAll('[role="option"]').length);
        record(
          r.site,
          "site reacted (new options appeared)",
          fresh.length > 0,
          `${fresh.length} new in snapshot (${Object.keys(s.elements).length} elements); ${domOptions} role=option in DOM: ${fresh
            .slice(0, 3)
            .map(([, e]: any) => e.name.slice(0, 40))
            .join(" | ")}`,
        );
        const firstNew = fresh.find(([, e]: any) => e.role === "option" && !/^-+/.test(e.name))?.[0] ?? fresh[0]?.[0];
        if (firstNew) {
          const urlBefore = page.url();
          const target = s.elements[firstNew];
          await api("click", tab, 0, firstNew, mode);
          await page.waitForTimeout(2500);
          const s2 = await snap(tab).catch(() => null);
          const changed = page.url() !== urlBefore || (s2 && JSON.stringify(names(s2)) !== JSON.stringify(names(s)));
          record(
            r.site,
            "click a suggestion changes the page",
            !!changed,
            `clicked ${target.role} "${target.name}" → ${decodeURI(page.url())} title="${s2?.title ?? ""}"`,
          );
        }
      } catch (e: any) {
        record(r.site, "flow", false, String(e?.message ?? e).split("\n")[0]);
      }
      await page.close();
    }
    await ctx.close();
  }
  fs.writeFileSync(path.join(OUT, "actions.json"), JSON.stringify(out, null, 2));
}

// ---------- spike 1 (automatable part): mic in an extension page ----------
async function micSpike() {
  const results: any = {};
  // a) Fake device, auto-accepted prompt: proves capture + AudioWorklet work under the extension CSP.
  {
    const { ctx, sw } = await launch(["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]);
    const id = new URL(sw.url()).host;
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${id}/sidepanel.html`);
    results.fakeDeviceAutoAccept = await page.evaluate(() => (window as any).testMic());
    await ctx.close();
  }
  // b) Fake device, no auto-accept: what an extension page gets when nobody answers a prompt.
  {
    const { ctx, sw } = await launch(["--use-fake-device-for-media-stream"]);
    const id = new URL(sw.url()).host;
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${id}/sidepanel.html`);
    results.noPromptAnswer = await Promise.race([
      page.evaluate(() => (window as any).testMic()),
      new Promise((r) => setTimeout(() => r({ ok: false, error: "no answer within 6 s (prompt pending)" }), 6000)),
    ]);
    await ctx.close();
  }
  console.log(JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(OUT, "mic.json"), JSON.stringify(results, null, 2));
}

if (which === "snapshot" || which === "all") await snapshotSpike();
if (which === "actions" || which === "all") await actionsSpike();
if (which === "mic" || which === "all") await micSpike();
await mock.close();
await frames.close();
process.exit(0);
