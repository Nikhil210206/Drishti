/**
 * Print what Drishti "sees" on each Pathik Rail page (no API key needed).
 *   DRISHTI_HEADLESS=1 npm run snapshot -w @drishti/dev-harness
 */
import { formatPage } from "@drishti/core";
import { config } from "../src/config.js";
import { PlaywrightDriver } from "../src/playwright-driver.js";
import { startMockSite } from "../src/mock-server.js";

const mock = await startMockSite();

const b = new PlaywrightDriver();
const page = await b.ensure(`http://localhost:${config.mockPort}/${process.argv[2] ?? ""}`);
const show = async (label: string) => {
  const s = await b.snapshot();
  console.log(`\n==================== ${label} (${s.text.length} chars, ~${Math.round(s.text.length / 3.5)} tokens)\n${formatPage(s)}`);
  return s;
};

let s = await show("search page");
const id = (pred: (e: any) => boolean) => {
  const hit = Object.entries(s.elements).find(([, e]) => pred(e));
  if (!hit) throw new Error(`No element matching ${pred}`);
  return hit[0];
};
await b.type(
  id((e) => e.name === "FROM"),
  "Chennai",
);
s = await show("after typing From");
await b.click(id((e) => /Chennai Central/.test(e.name)));
await b.type(
  id((e) => e.name === "TO"),
  "Bengaluru",
);
s = await show("after typing To");
await b.click(id((e) => /KSR Bengaluru/.test(e.name)));
await b.click(id((e) => /journey date|^(Mon|Tue|Wed|Thu|Fri|Sat|Sun),/i.test(e.name)));
s = await show("calendar open");
await page.keyboard.press("Escape");
await page.click(".cal-close");
s = await show("search filled");
await b.click(id((e) => /SEARCH TRAINS/i.test(e.name)));
s = await show("results");
await b.click(id((e) => /book/i.test(e.name)));
s = await show("passengers");
await b.close();
await mock.close();
