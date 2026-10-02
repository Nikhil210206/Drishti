import { describe, expect, it, vi } from "vitest";
import { MemoryCache, PhraseBook, PHRASES } from "../src/index.js";

describe("PhraseBook", () => {
  it("uses the hand-checked table first", async () => {
    const translate = vi.fn();
    const book = new PhraseBook({ translate }, new MemoryCache());
    expect(await book.get("ready", "hi-IN")).toBe(PHRASES.ready["hi-IN"]);
    expect(translate).not.toHaveBeenCalled();
  });

  it("translates once and caches", async () => {
    const translate = vi.fn(async (t: string) => `ta:${t}`);
    const cache = new MemoryCache();
    const book = new PhraseBook({ translate }, cache);
    expect(await book.get("stopped", "ta-IN")).toBe(`ta:${PHRASES.stopped["en-IN"]}`);
    expect(await book.get("stopped", "ta-IN")).toBe(`ta:${PHRASES.stopped["en-IN"]}`);
    expect(translate).toHaveBeenCalledTimes(1);
    expect(await cache.get("stopped|ta-IN")).toBeDefined();
  });

  it("falls back to English if translation fails", async () => {
    const book = new PhraseBook({ translate: async () => Promise.reject(new Error("offline")) }, new MemoryCache());
    expect(await book.get("error", "kn-IN")).toBe(PHRASES.error["en-IN"]);
  });
});
