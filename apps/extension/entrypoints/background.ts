import { ExtensionDriver, type InputMode } from "../lib/extension-driver";

export default defineBackground(() => {
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

  // Test hook: the E2E runner (eval/lib/extension-bridge.ts) drives a tab through the real
  // ExtensionDriver from Playwright. Only code that can already debug the service worker can call it.
  const drivers = new Map<number, ExtensionDriver>();
  (globalThis as any).drishtiTest = {
    async call(tabId: number, method: string, args: unknown[], input: InputMode = "debugger") {
      let d = drivers.get(tabId);
      if (!d) drivers.set(tabId, (d = new ExtensionDriver(tabId, { input })));
      const r = await (d as any)[method](...args);
      return r instanceof Uint8Array ? Array.from(r) : r;
    },
    async release(tabId: number) {
      await drivers.get(tabId)?.dispose();
      drivers.delete(tabId);
    },
  };
});
