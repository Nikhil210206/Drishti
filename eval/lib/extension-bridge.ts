/**
 * BrowserDriver for the eval that goes through the real extension: Chromium loads the built
 * extension (apps/extension/.output/chrome-mv3), and every call runs in its service worker on the
 * shipped ExtensionDriver. The agent stays in Node, so cassettes replay exactly as with Playwright,
 * and CI checks the product's own page code at no API cost.
 *
 *   npm run build -w @drishti/extension && npm run eval -- --driver=extension
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Page, type Worker } from "playwright";
import type { BrowserDriver, Snapshot, SnapshotOptions } from "@drishti/core";
import { ROOT } from "../../apps/dev-harness/src/config.js";

export const EXTENSION_DIR = path.join(ROOT, "apps/extension/.output/chrome-mv3");

export class ExtensionBridge implements BrowserDriver {
  private context?: BrowserContext;
  private sw?: Worker;
  private tabId?: number;
  page?: Page;

  constructor(
    private opts: {
      headless?: boolean;
      fixedTime?: string;
      offline?: boolean;
      input?: "debugger" | "synthetic";
    } = {},
  ) {}

  async ensure(startUrl: string): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    if (!fs.existsSync(path.join(EXTENSION_DIR, "manifest.json")))
      throw new Error("Build the extension first: npm run build -w @drishti/extension");
    this.context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      headless: this.opts.headless ?? true,
      viewport: { width: 1160, height: 1000 },
      locale: "en-IN",
      args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
    });
    if (this.opts.fixedTime) await this.context.clock.setFixedTime(new Date(this.opts.fixedTime));
    if (this.opts.offline) {
      await this.context.route("**/*", (route) => {
        const host = new URL(route.request().url()).hostname;
        return host === "localhost" || host === "127.0.0.1" ? route.continue() : route.abort();
      });
    }
    this.sw = this.context.serviceWorkers()[0] ?? (await this.context.waitForEvent("serviceworker"));
    await this.sw.evaluate(() => new Promise<void>((r) => ((globalThis as any).drishtiTest ? r() : setTimeout(r, 200))));
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    this.context.on("page", (p) => (this.page = p));
    await this.page.goto(startUrl, { waitUntil: "domcontentloaded" });
    const url = this.page.url();
    this.tabId = await this.sw.evaluate(
      async (u) => ((await (globalThis as any).chrome.tabs.query({})) as { id?: number; url?: string }[]).find((t) => t.url === u)?.id,
      url,
    );
    if (this.tabId === undefined) throw new Error(`The extension cannot see the tab at ${url}`);
    return this.page;
  }

  private call<T>(method: string, ...args: unknown[]): Promise<T> {
    if (!this.sw || this.tabId === undefined) throw new Error("ExtensionBridge.ensure() first");
    return this.sw.evaluate(([tabId, m, a, input]) => (globalThis as any).drishtiTest.call(tabId, m, a, input), [
      this.tabId,
      method,
      args,
      this.opts.input ?? "debugger",
    ] as const) as Promise<T>;
  }

  snapshot(opts: SnapshotOptions = {}) {
    return this.call<Snapshot>("snapshot", opts);
  }
  signature() {
    return this.call<string>("signature");
  }
  url() {
    return this.call<string>("url");
  }
  click(id: string | number) {
    return this.call<void>("click", id);
  }
  type(id: string | number, text: string, submit?: boolean) {
    return this.call<void>("type", id, text, submit);
  }
  selectOption(id: string | number, option: string) {
    return this.call<void>("selectOption", id, option);
  }
  press(key: string) {
    return this.call<void>("press", key);
  }
  scroll(direction: "up" | "down") {
    return this.call<void>("scroll", direction);
  }
  goBack() {
    return this.call<void>("goBack");
  }
  navigate(url: string) {
    return this.call<void>("navigate", url);
  }
  focus(id: string | number) {
    return this.call<void>("focus", id);
  }
  readable() {
    return this.call<{ title: string; text: string }>("readable");
  }
  async fetchBytes(url: string) {
    return new Uint8Array(await this.call<number[]>("fetchBytes", url));
  }

  async close() {
    await this.context?.close().catch(() => {});
    this.context = undefined;
    this.page = undefined;
  }
}
