import { describe, expect, it } from "vitest";
import type { BrowserDriver } from "@drishti/core";
import { GatedDriver, SiteAccess, siteOf, sitePatterns, type SiteAccessDeps } from "../lib/site-access";

function deps(answers: (string | null)[], request: (origins: string[]) => Promise<boolean>, granted: string[] = []) {
  const log: string[] = [];
  const d: SiteAccessDeps = {
    contains: async (origins) => granted.some((g) => origins[0].includes(g)),
    request: async (origins) => (log.push(`request ${origins.join(" ")}`), request(origins)),
    ask: async (q) => (log.push(`ask ${q}`), answers.shift() ?? null),
    say: async (key) => void log.push(`say ${key}`),
    phrase: async (key) => key,
    granted: (site) => void log.push(`granted ${site}`),
  };
  return { d, log };
}

describe("siteOf", () => {
  it.each([
    ["www.irctc.co.in", "irctc.co.in"],
    ["hi.wikipedia.org", "wikipedia.org"],
    ["uidai.gov.in", "uidai.gov.in"],
    ["myaadhaar.uidai.gov.in", "uidai.gov.in"],
    ["localhost", "localhost"],
    ["127.0.0.1", "127.0.0.1"],
  ])("%s → %s", (host, site) => expect(siteOf(host)).toBe(site));

  it("asks Chrome for the whole site, both schemes", () => {
    expect(sitePatterns("irctc.co.in")).toEqual(["https://*.irctc.co.in/*", "http://*.irctc.co.in/*"]);
  });
});

describe("SiteAccess", () => {
  const IRCTC = "https://www.irctc.co.in/nget/train-search";

  it("does not ask about a site Drishti already has", async () => {
    const { d, log } = deps([], async () => true, ["www.irctc.co.in"]);
    expect(await new SiteAccess(d).ensure(IRCTC)).toBe(true);
    expect(log).toEqual([]);
  });

  it("asks, and on a yes asks Chrome for the site and remembers it", async () => {
    const { d, log } = deps(["haan"], async () => true);
    expect(await new SiteAccess(d).ensure(IRCTC)).toBe(true);
    expect(log).toEqual(["ask irctc.co.in: siteAccess", "request https://*.irctc.co.in/* http://*.irctc.co.in/*", "granted irctc.co.in"]);
  });

  it("stops on a no, says so, and does not ask again in the same task", async () => {
    const { d, log } = deps(["नहीं", "हाँ"], async () => true);
    const access = new SiteAccess(d);
    expect(await access.ensure(IRCTC)).toBe(false);
    expect(await access.ensure("https://irctc.co.in/other")).toBe(false);
    expect(log).toEqual(["ask irctc.co.in: siteAccess", "say siteDenied"]);
    // A new request asks again.
    access.newTask();
    expect(await access.ensure(IRCTC)).toBe(true);
  });

  it("asks for the button when a spoken yes came too late for Chrome", async () => {
    let calls = 0;
    const { d, log } = deps(["yes", "yes"], async () => {
      if (calls++ === 0) throw new Error("This function must be called during a user gesture");
      return true;
    });
    expect(await new SiteAccess(d).ensure(IRCTC)).toBe(true);
    expect(log.filter((l) => !l.startsWith("request"))).toEqual([
      "ask irctc.co.in: siteAccess",
      "say pressYes",
      "ask irctc.co.in: siteAccess",
      "granted irctc.co.in",
    ]);
  });

  it("treats Deny in Chrome's box as a no", async () => {
    const { d, log } = deps(["yes"], async () => false);
    expect(await new SiteAccess(d).ensure(IRCTC)).toBe(false);
    expect(log.at(-1)).toBe("say siteDenied");
  });

  it("never asks about pages that aren't websites", async () => {
    const { d, log } = deps([], async () => true);
    expect(await new SiteAccess(d).ensure("chrome://newtab/")).toBe(true);
    expect(log).toEqual([]);
  });
});

describe("GatedDriver", () => {
  it("does not touch a page the user refused", async () => {
    const touched: string[] = [];
    const inner = {
      url: async () => "https://www.irctc.co.in/",
      click: async (id: number) => void touched.push(`click ${id}`),
    } as unknown as BrowserDriver;
    const { d } = deps(["no"], async () => true);
    const access = new SiteAccess(d);
    const driver = new GatedDriver(inner, () => access);
    await expect(driver.click(3)).rejects.toMatchObject({ name: "UserDeclined" });
    expect(touched).toEqual([]);
  });
});
