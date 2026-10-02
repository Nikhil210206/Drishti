import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import type { Snapshot, SnapshotOptions } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, "../../../fixtures/html");
// Same serialisation the Playwright driver uses: the function source, run inside the page.
const SNAPSHOT_FN = fs
  .readFileSync(path.resolve(here, "../src/snapshot.js"), "utf8")
  .replace(/^(\s*\/\/.*\n)+/, "")
  .replace(/^export function/m, "function")
  .trim();

let browser: Browser;
let pg: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  pg = await browser.newPage({ viewport: { width: 1200, height: 900 } });
});
afterAll(async () => browser?.close());

async function snap(html: string, opts: SnapshotOptions = {}): Promise<Snapshot> {
  // Serve from a real origin so relative links resolve like on a website.
  await pg.route("http://fixture.test/**", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await pg.goto("http://fixture.test/page", { waitUntil: "load" });
  await pg.unroute("http://fixture.test/**");
  return pg.evaluate(`(${SNAPSHOT_FN})(${JSON.stringify(opts)})`) as Promise<Snapshot>;
}
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf8");
const byName = (s: Snapshot, name: string) => Object.values(s.elements).find((e) => e.name === name);

describe("snapshot page model", () => {
  let s: Snapshot;
  beforeAll(async () => {
    s = await snap(fixture("labels.html"));
  });

  it("names unlabelled icon buttons from their classes, marked inferred", () => {
    expect(byName(s, "search")).toMatchObject({ inferred: true, role: "clickable" });
    expect(byName(s, "cart")).toMatchObject({ inferred: true });
    expect(s.text).toMatch(/\[\d+\] clickable "search" \(inferred\)/);
  });

  it("names a field from the visual label next to it", () => {
    expect(byName(s, "Age")).toMatchObject({ inferred: true, role: "textbox" });
  });

  it("prefers real labels", () => {
    expect(byName(s, "Passenger name")).toMatchObject({ inferred: false });
    expect(byName(s, "Close dialog")).toMatchObject({ inferred: false });
  });

  it("names colour-only indicators", () => {
    expect(s.text).toContain("(colour: green)");
    expect(s.text).toContain("(colour: red)");
  });

  it("marks password fields and visual-only selection", () => {
    expect(s.text).toMatch(/textbox "Password" value="" password-field/);
    expect(s.text).toMatch(/radio "Sleeper".*looks-selected/);
  });

  it("leaves out hidden and aria-hidden controls", () => {
    expect(byName(s, "Hidden pay")).toBeUndefined();
    expect(byName(s, "Decorative")).toBeUndefined();
  });

  it("lists PDF links", () => {
    expect(s.pdfLinks).toEqual([
      expect.objectContaining({ name: "Electricity bill (PDF)", href: expect.stringMatching(/\/docs\/bill\.pdf$/) }),
    ]);
  });

  it("walks same-origin iframes", () => {
    expect(byName(s, "Inside frame")).toBeDefined();
  });

  it("keeps element ids stable across snapshots", async () => {
    const again = (await pg.evaluate(`(${SNAPSHOT_FN})({})`)) as Snapshot;
    expect(Object.keys(again.elements)).toEqual(Object.keys(s.elements));
  });
});

describe("snapshot robustness", () => {
  it("survives a PDF link that cannot be resolved", async () => {
    await pg.setContent('<a href="bill.pdf">Bill</a><button>Pay</button>');
    const s = (await pg.evaluate(`(${SNAPSHOT_FN})({})`)) as Snapshot;
    expect(byName(s, "Pay")).toBeDefined();
  });
});

describe("snapshot dialogs", () => {
  it("shows only the open dialog", async () => {
    const s = await snap(fixture("dialog.html"));
    expect(s.dialog).toBe("Choose date");
    expect(byName(s, "Tomorrow")).toBeDefined();
    expect(byName(s, "Behind button")).toBeUndefined();
  });
});

describe("snapshot real-site regressions", () => {
  it("ignores an off-canvas panel marked as a dialog (myScheme)", async () => {
    const s = await snap(`<h1>Schemes</h1><button>Find schemes</button>
      <div role="dialog" style="position:fixed; left:110vw; top:0; width:450px; height:100vh">Accessibility options<button>Bigger Text</button></div>`);
    expect(s.dialog).toBe("");
    expect(byName(s, "Find schemes")).toBeDefined();
  });

  it("walks through zero-size inline component hosts (IRCTC's app-jp-input)", async () => {
    const s = await snap(`<app-root><app-jp-input><div style="width:300px"><form>
      <input role="searchbox" aria-label="Enter From station. Input is Mandatory."></form></div></app-jp-input>
      <x-wrap style="display:contents"><div><button>Find trains</button></div></x-wrap></app-root>`);
    expect(byName(s, "Enter From station. Input is Mandatory.")).toBeDefined();
    expect(byName(s, "Find trains")).toBeDefined();
  });

  it("lists the options inside a listbox (IRCTC station suggestions)", async () => {
    const s = await snap(`<input role="searchbox" aria-label="From"><div class="panel"><ul role="listbox">
      <li role="option">MGR CHENNAI CTL - MAS</li><li role="option">CHENNAI EGMORE - MS</li></ul></div>
      <div role="tablist"><span role="tab">Trains</span><span role="tab">Flights</span></div>`);
    expect(byName(s, "MGR CHENNAI CTL - MAS")).toMatchObject({ role: "option" });
    expect(byName(s, "CHENNAI EGMORE - MS")).toBeDefined();
    expect(byName(s, "Flights")).toMatchObject({ role: "tab" });
  });

  it("keeps the input and its suggestions when a pointer-cursor wrapper holds them, even in a row (IRCTC)", async () => {
    const col = (inner: string) => `<div class="col" style="padding:4px">${inner}</div>`;
    const s = await snap(`<div class="swap">
      ${col(`<span class="ac" style="cursor:pointer;display:inline-block"><input aria-label="Enter From station">
        <div><ul role="listbox"><li role="option">MGR CHENNAI CTL - MAS</li><li role="option">CHENNAI EGMORE - MS</li></ul></div></span> से`)}
      ${col(`<span class="ac" style="cursor:pointer;display:inline-block"><input aria-label="Enter To station"></span> तक`)}
      ${col(`<span>Journey date and class here</span>`)}</div>`);
    expect(byName(s, "Enter From station")).toBeDefined();
    expect(byName(s, "MGR CHENNAI CTL - MAS")).toMatchObject({ role: "option" });
    expect(Object.values(s.elements).some((e) => e.name.includes("MGR CHENNAI CTL - MAS CHENNAI EGMORE"))).toBe(false);
  });

  it("still prunes hidden wrappers", async () => {
    const s = await snap(`<x-wrap style="display:contents" aria-hidden="true"><div><button>Secret</button></div></x-wrap>
      <x-wrap style="display:none"><div><button>Gone</button></div></x-wrap>`);
    expect(byName(s, "Secret")).toBeUndefined();
    expect(byName(s, "Gone")).toBeUndefined();
  });

  it("clips absurdly long aria-labels (IRCTC)", async () => {
    const s = await snap(
      `<button aria-label="Confirmation. SafeValue must use [property]=binding: ${"<h1>x</h1>".repeat(60)}">OK</button>`,
    );
    const [el] = Object.values(s.elements);
    expect(el.name.length).toBeLessThanOrEqual(120);
  });
});

describe("snapshot token cap", () => {
  const long = `<h1>Notice</h1>${Array.from({ length: 400 }, (_, i) => `<p>Paragraph ${i} ${"lorem ipsum dolor sit amet ".repeat(4)}</p>`).join("")}<button>Apply now</button>`;

  it("stays under maxChars", async () => {
    const s = await snap(long, { maxChars: 3000 });
    expect(s.text.length).toBeLessThanOrEqual(3000 + 60);
  });

  it("drops long text before controls", async () => {
    const s = await snap(long, { maxChars: 3000 });
    expect(s.text).toContain('"Apply now"');
  });

  it("caps the number of elements", async () => {
    const many = Array.from({ length: 300 }, (_, i) => `<button>B${i}</button>`).join("");
    const s = await snap(many, { maxElements: 50 });
    expect(Object.keys(s.elements).length).toBeLessThanOrEqual(50);
  });
});
