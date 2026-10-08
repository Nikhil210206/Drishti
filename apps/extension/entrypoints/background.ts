import { Commands } from "../lib/commands";
import { ExtensionDriver, type InputMode } from "../lib/extension-driver";
import { saveSettings } from "../lib/settings";
import { WEBSITE_ORIGINS, looksLikeToken } from "../lib/website";

export default defineBackground(() => {
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

  // First install: the spoken welcome (language, connect, consent, microphone, voice, practice).
  chrome.runtime.onInstalled.addListener((d) => {
    if (d.reason === "install") void chrome.tabs.create({ url: chrome.runtime.getURL("/welcome.html") });
  });

  /** Site requests the Yes shortcut made (for the E2E test). */
  const siteRequests: string[][] = [];
  // Global shortcuts (lib/commands.ts): to the panel, or straight to Chrome for a site grant.
  const commands = new Commands({
    openPanel: (windowId) => void chrome.sidePanel.open({ windowId }).catch(() => {}),
    request: (origins) => {
      const r = chrome.permissions.request({ origins });
      siteRequests.push(origins);
      r.then(
        (allowed) => siteRequests.push([`allowed ${allowed}`]),
        (e) => siteRequests.push([`refused: ${e?.message}`]),
      );
      return r;
    },
    send: (msg) => void chrome.runtime.sendMessage(msg).catch(() => {}),
  });
  chrome.commands.onCommand.addListener((command, tab) => commands.handle(command, tab?.windowId));
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "drishti-pending") commands.setPending(msg.origins);
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
    /** A shortcut press, as Chrome would deliver it. */
    command(command: string, windowId?: number) {
      commands.handle(command, windowId);
    },
    siteRequests,
    async release(tabId: number) {
      await drivers.get(tabId)?.dispose();
      drivers.delete(tabId);
    },
  };
});
