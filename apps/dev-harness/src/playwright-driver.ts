import fs from "node:fs";
import { createRequire } from "node:module";
import { chromium, type Browser, type BrowserContext, type Page, type Locator } from "playwright";
import type { BrowserDriver, Snapshot, SnapshotOptions } from "@drishti/core";
import { config } from "./config.js";

const require = createRequire(import.meta.url);

/**
 * snapshot.js as an expression that evaluates to the function. Read as text rather than
 * imported, so no transpiler helpers end up inside the code that runs in the page.
 */
export const SNAPSHOT_FN = fs
  .readFileSync(require.resolve("@drishti/core/snapshot.js"), "utf8")
  .replace(/^(\s*\/\/.*\n)+/, "")
  .replace(/^export function/m, "function")
  .trim();
const READABILITY_SRC = fs.readFileSync(require.resolve("@mozilla/readability/Readability.js"), "utf8");

/** BrowserDriver on a Playwright-launched Chromium (dev harness, eval, CI). */
export class PlaywrightDriver implements BrowserDriver {
  private browser?: Browser;
  private context?: BrowserContext;
  page?: Page;
  private starting?: Promise<Page>;

  constructor(
    private opts: {
      headless?: boolean;
      /** Freeze Date/Date.now in the page (deterministic eval and cassette replay). */
      fixedTime?: string;
      /** Abort requests to anything but localhost (offline, deterministic eval). */
      offline?: boolean;
    } = {},
  ) {}

  async ensure(startUrl?: string): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const w = config.browserWindow;
      this.browser = await chromium.launch({
        headless: this.opts.headless ?? config.headless,
        args: [`--window-position=${w.x},${w.y}`, `--window-size=${w.width},${w.height}`, "--disable-infobars"],
      });
      this.context = await this.browser.newContext({ viewport: null, locale: "en-IN" });
      if (this.opts.fixedTime) await this.context.clock.setFixedTime(new Date(this.opts.fixedTime));
      if (this.opts.offline) {
        await this.context.route("**/*", (route) => {
          const host = new URL(route.request().url()).hostname;
          return host === "localhost" || host === "127.0.0.1" ? route.continue() : route.abort();
        });
      }
      this.page = await this.context.newPage();
      // Keep following the newest tab if a site opens one.
      this.context.on("page", (p) => (this.page = p));
      await this.page.goto(startUrl ?? `http://localhost:${config.mockPort}/`, { waitUntil: "domcontentloaded" });
      return this.page;
    })();
    try {
      return await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  async snapshot(opts: SnapshotOptions = {}): Promise<Snapshot> {
    const page = await this.ensure();
    await this.settle(page);
    return page.evaluate(`(${SNAPSHOT_FN})(${JSON.stringify(opts)})`) as Promise<Snapshot>;
  }

  async url(): Promise<string> {
    const page = await this.ensure();
    return page.url();
  }

  private async settle(page: Page) {
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 5000 });
    } catch {}
    await page.waitForTimeout(150);
  }

  private locate(id: string | number): Locator {
    return this.page!.locator(`[data-drishti-id="${id}"]`).first();
  }

  async click(id: string | number) {
    await this.ensure();
    const loc = this.locate(id);
    await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    try {
      await loc.click({ timeout: 2500 });
    } catch (e) {
      // Usually an open popup covers the target; fire the click on the element itself.
      if (!(await loc.count())) throw e;
      await loc.dispatchEvent("click");
    }
    await this.afterAction();
  }

  /** Cheap fingerprint of the page structure, to notice popups/suggestions appearing. */
  async signature(): Promise<string> {
    const page = await this.ensure();
    return page.evaluate(() => `${location.href}|${document.querySelectorAll("body *").length}`).catch(() => "");
  }

  async type(id: string | number, text: string, submit = false) {
    await this.ensure();
    const loc = this.locate(id);
    await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    const editable = await loc.evaluate(
      (el) => (el as HTMLElement).isContentEditable && el.tagName !== "INPUT" && el.tagName !== "TEXTAREA",
    );
    if (editable) {
      await loc.click({ timeout: 5000 });
      await this.page!.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
      await this.page!.keyboard.type(text, { delay: 10 });
    } else {
      await loc.fill(text, { timeout: 5000 });
      // Many autocomplete widgets only react to key events, so nudge them.
      await loc.dispatchEvent("keyup").catch(() => {});
    }
    if (submit) await loc.press("Enter");
    await this.afterAction();
  }

  async selectOption(id: string | number, option: string) {
    await this.ensure();
    const loc = this.locate(id);
    const isSelect = await loc.evaluate((el) => el.tagName === "SELECT");
    if (isSelect) {
      const labels: string[] = await loc.evaluate((el) => Array.from((el as HTMLSelectElement).options).map((o) => o.text.trim()));
      const want = option.toLowerCase();
      const match =
        labels.find((l) => l.toLowerCase() === want) ??
        labels.find((l) => l.toLowerCase().includes(want)) ??
        labels.find((l) => want.includes(l.toLowerCase()));
      if (!match) throw new Error(`No option like "${option}". Options: ${labels.join(", ")}`);
      await loc.selectOption({ label: match });
    } else {
      // Custom dropdown: open it, then click the visible option with matching text.
      await loc.click({ timeout: 2500 }).catch(() => loc.dispatchEvent("click"));
      await this.page!.waitForTimeout(200);
      const opt = this.page!.getByText(option, { exact: false }).locator("visible=true").last();
      await opt.click({ timeout: 4000 });
    }
    await this.afterAction();
  }

  async press(key: string) {
    const page = await this.ensure();
    await page.keyboard.press(key);
    await this.afterAction();
  }

  async scroll(direction: "up" | "down") {
    const page = await this.ensure();
    await page.mouse.wheel(0, direction === "down" ? 600 : -600);
    await page.waitForTimeout(250);
  }

  async goBack() {
    const page = await this.ensure();
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => {});
    await this.afterAction();
  }

  async navigate(url: string) {
    const page = await this.ensure();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await this.afterAction();
  }

  async focus(id: string | number) {
    await this.ensure();
    await this.locate(id)
      .focus({ timeout: 3000 })
      .catch(() => {});
  }

  /** Main readable text of the page (Mozilla Readability, falling back to body text). */
  async readable(): Promise<{ title: string; text: string }> {
    const page = await this.ensure();
    const hasReadability = await page.evaluate(() => typeof (window as any).Readability === "function");
    if (!hasReadability) await page.addScriptTag({ content: READABILITY_SRC }).catch(() => {});
    return page.evaluate(() => {
      const w = window as any;
      try {
        if (typeof w.Readability === "function") {
          const art = new w.Readability(document.cloneNode(true)).parse();
          if (art?.textContent && art.textContent.trim().length > 200) {
            return { title: art.title || document.title, text: art.textContent.replace(/\s+/g, " ").trim() };
          }
        }
      } catch {}
      return { title: document.title, text: (document.body?.innerText || "").replace(/\s+/g, " ").trim() };
    });
  }

  async fetchBytes(url: string): Promise<Uint8Array> {
    const page = await this.ensure();
    const res = await page.request.get(url);
    if (!res.ok()) throw new Error(`Download failed HTTP ${res.status()}`);
    return Buffer.from(await res.body());
  }

  private async afterAction() {
    const page = this.page!;
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);
  }

  async close() {
    await this.browser?.close().catch(() => {});
    this.browser = undefined;
    this.page = undefined;
  }
}
