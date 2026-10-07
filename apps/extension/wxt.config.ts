import { createRequire } from "node:module";
import { defineConfig } from "wxt";

const require = createRequire(import.meta.url);
// Keep in step with lib/website.ts.
const WEBSITE_ORIGINS = ["http://localhost:5175", "https://drishti.pages.dev"];

// Drishti's MV3 extension. Host access is asked for per site, by voice (Phase 2 onboarding);
// localhost is granted up front for Pathik Rail practice mode and the eval.
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "Drishti",
    description: "Voice-first web assistant for blind and low-vision users, in 11 Indian languages.",
    permissions: ["scripting", "debugger", "tabs", "sidePanel", "storage", "webNavigation"],
    // Localhost: Pathik Rail practice mode and the eval. Sarvam's storage: Doc AI hands back a signed
    // link there, and fetching it directly keeps bills off our proxy.
    host_permissions: ["http://localhost/*", "http://127.0.0.1/*", "https://appsprodaksharpublicsa.blob.core.windows.net/*"],
    optional_host_permissions: ["https://*/*", "http://*/*"],
    action: { default_title: "Drishti" },
    // Only the website's connect page may talk to the extension, to hand over a device token.
    externally_connectable: { matches: WEBSITE_ORIGINS.map((o) => `${o}/*`) },
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
