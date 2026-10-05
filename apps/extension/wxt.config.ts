import { createRequire } from "node:module";
import { defineConfig } from "wxt";

const require = createRequire(import.meta.url);

// Drishti's MV3 extension. Host access is asked for per site, by voice (Phase 2 onboarding);
// localhost is granted up front for Pathik Rail practice mode and the eval.
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "Drishti",
    description: "Voice-first web assistant for blind and low-vision users, in 11 Indian languages.",
    permissions: ["scripting", "debugger", "tabs", "sidePanel", "storage", "webNavigation"],
    host_permissions: ["http://localhost/*", "http://127.0.0.1/*"],
    optional_host_permissions: ["https://*/*", "http://*/*"],
    action: { default_title: "Drishti" },
  },
  hooks: {
    // Mozilla Readability, injected on demand for read_page (ExtensionDriver.readable).
    "build:publicAssets": (_wxt, assets) => {
      assets.push({ absoluteSrc: require.resolve("@mozilla/readability/Readability.js"), relativeDest: "readability.js" });
    },
  },
});
