import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionDriver } from "../lib/extension-driver";

/**
 * Chrome as the driver sees it, with the debugger's rules: one attachment per tab, and commands
 * only to a tab the extension is attached to.
 */
function fakeChrome() {
  const attached = new Set<number>();
  const log: string[] = [];
  const scripts: string[] = [];
  let canScript = true;
  vi.stubGlobal("chrome", {
    debugger: {
      attach: async ({ tabId }: { tabId: number }) => {
        if (attached.has(tabId)) throw new Error(`Another debugger is already attached to the tab with id: ${tabId}.`);
        attached.add(tabId);
        log.push(`attach ${tabId}`);
      },
      detach: async ({ tabId }: { tabId: number }) => {
        if (!attached.delete(tabId)) throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`);
        log.push(`detach ${tabId}`);
      },
      sendCommand: async ({ tabId }: { tabId: number }, method: string) => {
        if (!attached.has(tabId)) throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`);
        log.push(`${method} ${tabId}`);
      },
      onDetach: { addListener() {}, removeListener() {} },
    },
    tabs: {
      get: async (id: number) => ({ id, status: "complete", url: "https://example.org/" }),
      goBack: async (id: number) => void log.push(`tabs.goBack ${id}`),
      onCreated: { addListener() {}, removeListener() {} },
    },
    scripting: {
      executeScript: async ({ func }: { func: (...a: unknown[]) => unknown }) => {
        if (!canScript) throw new Error("Cannot access contents of the page.");
        scripts.push(func.name || String(func));
        // pageBox: a visible element nobody covers; focusAndSelect: focused.
        return [{ result: func.name === "focusAndSelect" ? "ok" : { x: 10, y: 10, covered: false } }];
      },
    },
  });
  return { attached, log, scripts, blockScripts: () => (canScript = false) };
}

afterEach(() => vi.unstubAllGlobals());

describe("ExtensionDriver", () => {
  it("moves the debugger with the user to another tab", async () => {
    const chrome = fakeChrome();
    const driver = new ExtensionDriver(1);
    await driver.click("5");
    expect([...chrome.attached]).toEqual([1]);

    // The user switches tabs within the idle window: the next click is trusted input on tab 2,
    // and tab 1 is let go (before, every click failed with "not attached to the tab with id: 2").
    driver.follow(2);
    await driver.click("6");
    await driver.type("7", "Chennai");
    expect([...chrome.attached]).toEqual([2]);
    expect(chrome.log.filter((l) => l.startsWith("Input."))).toEqual([
      "Input.dispatchMouseEvent 1",
      "Input.dispatchMouseEvent 1",
      "Input.dispatchMouseEvent 1",
      "Input.dispatchMouseEvent 2",
      "Input.dispatchMouseEvent 2",
      "Input.dispatchMouseEvent 2",
      "Input.insertText 2",
      "Input.dispatchKeyEvent 2",
      "Input.dispatchKeyEvent 2",
    ]);

    await driver.dispose();
    expect([...chrome.attached]).toEqual([]);
  });

  it("goes back with the page's own history, so pages left without a gesture are not skipped", async () => {
    const chrome = fakeChrome();
    const driver = new ExtensionDriver(1, { input: "synthetic" });
    await driver.goBack();
    expect(chrome.scripts).toHaveLength(1);
    expect(chrome.log).toEqual([]);

    // A page scripts can't run in: the browser's back button instead.
    chrome.blockScripts();
    await driver.goBack();
    expect(chrome.log).toEqual(["tabs.goBack 1"]);
    await driver.dispose();
  });
});
