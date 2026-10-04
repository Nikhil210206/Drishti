/**
 * Save a real page as a static, offline fixture for reading tasks:
 *   npx tsx eval/save-page.ts <url> <name> [--headed]
 * Writes fixtures/sites/<name>/index.html (rendered DOM, scripts removed, stylesheets inlined,
 * images and external requests dropped) and SOURCE.md (URL, date, licence note to fill in).
 * Some sites (IRCTC, india.gov.in) block headless browsers: use --headed.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { FIXTURES } from "../apps/dev-harness/src/config.js";

const [url, name] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!url || !name) throw new Error("usage: npx tsx eval/save-page.ts <url> <name> [--headed]");

const browser = await chromium.launch({ headless: !process.argv.includes("--headed") });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "en-IN" });
await page.goto(url, { waitUntil: "networkidle", timeout: 60000 }).catch(() => page.waitForLoadState("domcontentloaded"));
await page.waitForTimeout(2500);

// Inline every stylesheet we can read, so visibility (menus, hidden panels) matches the live page.
const css: string[] = [];
for (const href of await page.evaluate(() =>
  Array.from(document.querySelectorAll('link[rel="stylesheet"]'), (l) => (l as HTMLLinkElement).href),
)) {
  const res = await page.request.get(href).catch(() => null);
  if (res?.ok()) css.push(`/* ${href} */\n${(await res.text()).replace(/url\([^)]*\)/g, "none")}`);
}

const html = await page.evaluate((inlineCss) => {
  const doc = document.documentElement.cloneNode(true) as HTMLElement;
  doc
    .querySelectorAll("script, noscript, link[rel=stylesheet], link[rel=preload], link[rel=prefetch], iframe, video, audio, source")
    .forEach((n) => n.remove());
  doc.querySelectorAll("[src], [srcset]").forEach((n) => {
    n.removeAttribute("srcset");
    if (n.tagName === "IMG") n.setAttribute("src", "data:image/gif;base64,R0lGODlhAQABAAAAACw=");
    else n.removeAttribute("src");
  });
  doc.querySelectorAll("[data-drishti-id]").forEach((n) => n.removeAttribute("data-drishti-id"));
  const style = document.createElement("style");
  style.textContent = inlineCss;
  doc.querySelector("head")?.append(style);
  return "<!doctype html>\n" + doc.outerHTML;
}, css.join("\n"));

const dir = path.join(FIXTURES, "sites", name);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "index.html"), html);
fs.writeFileSync(
  path.join(dir, "SOURCE.md"),
  `# ${name}\n\n- Source: ${url}\n- Saved: ${new Date().toISOString().slice(0, 10)} with \`eval/save-page.ts\` (scripts, images and external requests removed)\n- Licence: FILL IN before committing\n`,
);
console.log(`saved ${(html.length / 1024).toFixed(0)} KB → ${path.relative(process.cwd(), dir)}`);
await browser.close();
