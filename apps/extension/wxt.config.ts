import { createRequire } from "node:module";
import { defineConfig } from "wxt";
import { DEV_PROXY, DEV_WEBSITE, hostPermission, originOf } from "./lib/endpoints";

const require = createRequire(import.meta.url);

// Drishti's MV3 extension. Host access is asked for per site, by voice (Phase 2 onboarding);
// localhost is granted up front for Pathik Rail practice mode and the eval.
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  // A function: WXT loads .env.<mode> (.env.release) only after reading this file.
  manifest: () => {
    // The proxy and website this build talks to (lib/endpoints.ts).
    const PROXY = originOf(process.env.WXT_PROXY || DEV_PROXY);
    const WEBSITE = originOf(process.env.WXT_WEBSITE || DEV_WEBSITE);
    return manifest(PROXY, WEBSITE);
  },
  hooks: {
    // Mozilla Readability, injected on demand for read_page (ExtensionDriver.readable).
    "build:publicAssets": (_wxt, assets) => {
      assets.push({ absoluteSrc: require.resolve("@mozilla/readability/Readability.js"), relativeDest: "readability.js" });
      // The panel's mic worklet (AudioWorklet modules load by URL).
      assets.push({ absoluteSrc: require.resolve("@drishti/ui/pcm-capture.js"), relativeDest: "pcm-capture.js" });
    },
  },
});

function manifest(PROXY: string, WEBSITE: string) {
  // A development build: the local practice site, website and proxy. A release build has no localhost.
  const dev = WEBSITE === DEV_WEBSITE;
  return {
    name: "Drishti",
    description: "Voice-first web assistant for blind and low-vision users, in 11 Indian languages.",
    permissions: ["scripting", "debugger", "tabs", "sidePanel", "storage", "webNavigation"],
    // Localhost (development builds): Pathik Rail practice mode and the eval. The proxy: requests to
    // it skip CORS. The website: its practice copy of Pathik Rail. Sarvam's storage: Doc AI hands
    // back a signed link there, and fetching it directly keeps bills off our proxy.
    host_permissions: [
      ...new Set([
        ...(dev ? ["http://localhost/*", "http://127.0.0.1/*"] : []),
        hostPermission(PROXY),
        hostPermission(WEBSITE),
        "https://appsprodaksharpublicsa.blob.core.windows.net/*",
      ]),
    ],
    optional_host_permissions: ["https://*/*", "http://*/*"],
    action: { default_title: "Drishti" },
    // Global shortcuts: they work from the web page too, and screen readers pass Alt+Shift+letter
    // through (NVDA, JAWS and VoiceOver use their own modifier keys, and plain letters in browse
    // mode). Chrome allows four suggested keys; users can change them at chrome://extensions/shortcuts.
    commands: {
      talk: { suggested_key: { default: "Alt+Shift+D" }, description: "Open Drishti, or start and stop talking" },
      stop: { suggested_key: { default: "Alt+Shift+S" }, description: "Stop Drishti" },
      yes: { suggested_key: { default: "Alt+Shift+Y" }, description: "Answer yes to Drishti's question" },
      no: { suggested_key: { default: "Alt+Shift+N" }, description: "Answer no to Drishti's question" },
    },
    // Only this build's website (its connect page) may talk to the extension, to hand over a device token.
    externally_connectable: { matches: [`${WEBSITE}/*`] },
  };
}
