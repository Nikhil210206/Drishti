import { ExtensionDriver, type InputMode } from "../lib/extension-driver";
import { saveSettings } from "../lib/settings";
import { WEBSITE_ORIGINS, looksLikeToken } from "../lib/website";

export default defineBackground(() => {
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

  // First install: the spoken welcome (language, connect, consent, microphone, voice, practice).
  chrome.runtime.onInstalled.addListener((d) => {
    if (d.reason === "install") void chrome.tabs.create({ url: chrome.runtime.getURL("/welcome.html") });
  });

  // The website's connect page hands over a device token. Chrome only lets the origins in
  // externally_connectable send this; check again, and accept a token and nothing else.
  chrome.runtime.onMessageExternal.addListener((msg, sender, reply) => {
    if (!sender.origin || !WEBSITE_ORIGINS.includes(sender.origin) || msg?.type !== "drishti-token" || !looksLikeToken(msg.token)) {
      reply({ ok: false });
      return;
    }
    void saveSettings({ token: msg.token }).then(() => reply({ ok: true }));
    return true; // reply is async
  });

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
