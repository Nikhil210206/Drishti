/**
 * The website for Cloudflare Pages, built into apps/website/dist:
 *
 *   public/*    landing, privacy and connect pages
 *   practice/   Pathik Rail (fixtures/pathik-rail): the practice site the welcome flow opens
 *   config.js   where the connect page sends people: the proxy, and the Turnstile site key
 *
 *   DRISHTI_PROXY=https://drishti-proxy.<subdomain>.workers.dev TURNSTILE_SITEKEY=<site key> npm run build -w @drishti/website
 *   npx wrangler pages deploy apps/website/dist --project-name <project> --branch main
 *
 * Without the variables: the local proxy and Turnstile's always-pass test key, for local use only.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const OUT = path.join(ROOT, "dist");
const TEST_SITEKEY = "1x00000000000000000000AA";
const proxy = new URL(process.env.DRISHTI_PROXY ?? "http://localhost:8788").origin;
const sitekey = process.env.TURNSTILE_SITEKEY ?? TEST_SITEKEY;
const local = ["localhost", "127.0.0.1"].includes(new URL(proxy).hostname);
// The test key passes everyone, and only the test secret accepts its tokens: never deploy it.
if (!local && sitekey === TEST_SITEKEY) throw new Error("Set TURNSTILE_SITEKEY: the test key is for local use only.");

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, "public"), OUT, { recursive: true });
fs.cpSync(path.join(ROOT, "../../fixtures/pathik-rail"), path.join(OUT, "practice"), { recursive: true });
fs.writeFileSync(
  path.join(OUT, "config.js"),
  `// Written by scripts/build.ts: where this copy of the website sends people.\nwindow.DRISHTI_CONFIG = ${JSON.stringify({ proxy, turnstileSiteKey: sitekey }, null, 2)};\n`,
);
// The connect page hands a device token to the extension: never inside someone else's frame.
fs.writeFileSync(
  path.join(OUT, "_headers"),
  "/*\n  X-Frame-Options: DENY\n  Content-Security-Policy: frame-ancestors 'none'\n  Referrer-Policy: no-referrer\n",
);
console.log(
  `Website → ${path.relative(process.cwd(), OUT)} (proxy ${proxy}, ${sitekey === TEST_SITEKEY ? "Turnstile test key" : "Turnstile site key set"})`,
);
