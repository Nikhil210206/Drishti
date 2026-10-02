import { describe, expect, it } from "vitest";
import { NavigationPolicy, linkTarget } from "../src/index.js";

describe("NavigationPolicy", () => {
  const policy = new NavigationPolicy();

  it.each([
    "http://localhost:5174/#/results",
    "http://127.0.0.1:8787/",
    "https://hi.wikipedia.org/wiki/भारत",
    "https://wikipedia.org/",
    "https://www.india.gov.in/",
    "https://myscheme.gov.in/schemes",
    "https://www.bbc.com/hindi",
  ])("allows %s", (url) => {
    expect(policy.allows(url)).toBe(true);
  });

  it.each([
    "https://evilwikipedia.org/", // suffix without a dot boundary
    "https://wikipedia.org.evil.com/",
    "https://notbbc.com/",
    "https://gov.in.attacker.net/",
    "https://irctc.co.in/", // not on the default list
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,<h1>hi</h1>",
    "chrome://settings",
    "https://user:pass@wikipedia.org/",
    "not a url",
    "",
  ])("blocks %s", (url) => {
    expect(policy.allows(url)).toBe(false);
  });

  it("no longer allows a site just because its name was said", () => {
    // The old rule allowed any host whose first label appeared in the conversation.
    expect(policy.allows("https://irctc.evil.com/")).toBe(false);
  });

  it("takes extra domains", () => {
    const p = new NavigationPolicy(["irctc.co.in"]);
    expect(p.allows("https://www.irctc.co.in/nget/train-search")).toBe(true);
    expect(p.allows("http://localhost:5174/")).toBe(false);
  });

  it("resolves relative URLs against a base", () => {
    expect(policy.allows("/wiki/X", "https://en.wikipedia.org/wiki/Y")).toBe(true);
  });
});

describe("linkTarget", () => {
  const base = "http://localhost:5174/#/results";
  it("ignores in-page links", () => {
    expect(linkTarget("#/passengers", base)).toBe("");
    expect(linkTarget("javascript:void(0)", base)).toBe("");
    expect(linkTarget("mailto:help@example.com", base)).toBe("");
    expect(linkTarget("", base)).toBe("");
  });

  it("returns where a link goes", () => {
    expect(linkTarget("/docs/bill.pdf", base)).toBe("http://localhost:5174/docs/bill.pdf");
    expect(linkTarget("https://evil.example/", base)).toBe("https://evil.example/");
    expect(linkTarget("data:text/html,x", base)).toBe("data:text/html,x");
  });
});
