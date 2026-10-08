/**
 * The panel's VoiceSession, run inside the side panel itself: the agent drives the user's tab
 * through ExtensionDriver, and speech, the LLM, translation and Doc AI go through the Drishti
 * proxy with the device token. The panel UI talks to it through the same protocol as the dev
 * harness's WebSocket, so the React panel is unchanged.
 */
import { Agent, DEFAULT_ALLOWED_DOMAINS, NavigationPolicy, PhraseBook, VoiceSession } from "@drishti/core";
import { SarvamDocReader, SarvamLLM, SarvamTranslator, SttStream, TtsEngine, costMeter } from "@drishti/providers";
import type { PanelHandlers, PanelTransport } from "@drishti/ui";
import { ExtensionDriver } from "./extension-driver";
import { GatedDriver, SiteAccess } from "./site-access";
import { StorageCache, loadSettings, saveSettings, type Settings } from "./settings";
import { WEBSITE } from "./website";

/** The tab the agent works on: the active tab of the browser window this panel belongs to. */
async function targetTab(): Promise<chrome.tabs.Tab | undefined> {
  const here = await chrome.windows.getCurrent();
  // In a normal window that is the panel's own window; when the panel page is opened on its own
  // (tests, a detached window), use the last browser window the user was in.
  const win = here.type === "normal" ? here : await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  return tab;
}

/** Tell the background which site the panel is asking about (null: none), for the Yes shortcut. */
function pendingSite(origins: string[] | null) {
  void chrome.runtime.sendMessage({ type: "drishti-pending", origins }).catch(() => {});
}

export function localTransport(settings: Settings): PanelTransport {
  let session: VoiceSession | undefined;
  return {
    label: "Drishti",
    send: (msg) => session?.onMessage(msg),
    sendAudio: (pcm) => session?.onAudio(new Uint8Array(pcm)),
    connect(h: PanelHandlers) {
      let disposed = false;
      let cleanup = () => {};
      void (async () => {
        const tab = await targetTab();
        if (disposed) return;
        if (tab?.id === undefined) {
          h.event({ type: "error", message: "No browser tab to work in." });
          return;
        }
        const auth = { baseUrl: settings.proxyUrl, token: settings.token };
        const translator = new SarvamTranslator(auth);
        const phrases = new PhraseBook(translator, new StorageCache("phrase:"));
        // Drishti's own website too (exactly that host): its practice site.
        const policy = new NavigationPolicy([...DEFAULT_ALLOWED_DOMAINS, new URL(WEBSITE).hostname, ...(settings.sites ?? [])]);
        const driver = new ExtensionDriver(tab.id);
        // Ask before working on a site Drishti has no access to yet (lib/site-access.ts).
        const access = new SiteAccess({
          contains: (origins) => chrome.permissions.contains({ origins }),
          request: (origins) => chrome.permissions.request({ origins }),
          // While asking, the background knows the origins: the Yes shortcut asks Chrome itself.
          ask: async (question, origins) => {
            pendingSite(origins);
            try {
              return await session!.ask(question, "confirm");
            } finally {
              pendingSite(null);
            }
          },
          say: (key) => session!.sayPhrase(key),
          phrase: (key) => phrases.get(key, session!.lang),
          granted: (site) => {
            policy.allow(site);
            void loadSettings().then((s) => saveSettings({ sites: [...new Set([...(s.sites ?? []), site])] }));
          },
        });
        const browser = new GatedDriver(driver, () => access);
        const tts = new TtsEngine({ ...auth, model: "bulbul:v3", speaker: settings.speaker });
        tts.voice.pace = settings.pace;
        const agent = new Agent(
          {
            browser,
            llm: new SarvamLLM({ ...auth, model: "sarvam-105b" }),
            translator,
            docs: new SarvamDocReader(auth),
            phrases,
            policy,
          },
          { maxSteps: 25, firstStepReasoning: "none", profile: settings.profile },
        );
        session = new VoiceSession(
          {
            agent,
            browser,
            policy,
            phrases,
            speechOut: tts,
            createSpeechIn: () => new SttStream({ ...auth, model: "saaras:v4" }),
            sink: {
              event: (e) => {
                // "Delete my details" (confirmed by voice): wipe the saved profile from this device.
                if (e.type === "forget") void saveSettings({ profile: undefined });
                if (e.type === "task" && e.state === "running") access.newTask();
                // Keep the voice the user picks in the panel.
                if (e.type === "voice") void saveSettings({ speaker: String(e.speaker), pace: Number(e.pace) });
                if (e.type === "output") void saveSettings({ output: e.mode === "screenreader" ? "screenreader" : "voice" });
                h.event(e);
              },
              // A copy into its own ArrayBuffer: the player keeps what it is given.
              audio: (pcm) => h.audio(pcm.slice().buffer),
            },
          },
          { lang: settings.lang ?? "hi-IN", homeUrl: settings.homeUrl, output: settings.output },
        );
        // Follow the user to another tab in this window; a page opening a new tab is followed by
        // the driver itself.
        const onActivated = (info: { tabId: number; windowId: number }) => {
          if (info.windowId === tab.windowId) driver.follow(info.tabId);
        };
        chrome.tabs.onActivated.addListener(onActivated);
        const offCost = costMeter.onChange((inr) => h.event({ type: "cost", inr }));
        cleanup = () => {
          chrome.tabs.onActivated.removeListener(onActivated);
          offCost();
          session?.close();
          void driver.dispose();
          session = undefined;
        };
        h.open(true);
        h.event({ type: "status", browser: "ready" });
      })().catch((e) => h.event({ type: "error", message: String(e?.message ?? e) }));
      return () => {
        disposed = true;
        cleanup();
        h.open(false);
      };
    },
  };
}
