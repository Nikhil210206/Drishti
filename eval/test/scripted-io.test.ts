import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryCache, PhraseBook } from "@drishti/core";
import { ScriptedIO } from "../lib/scripted-io.js";
import { Trace } from "../lib/tracing.js";
import type { Task } from "../lib/tasks.js";

const phrases = new PhraseBook({ translate: async (t) => t }, new MemoryCache());
const user = (booking: Record<string, string | number>) => {
  const task: Task = { id: "t", lang: "en-IN", start: "/", command: "book", expect: { booking } } as Task;
  return new ScriptedIO("en-IN", task, phrases, new Trace(path.join(os.tmpdir(), `drishti-scripted-${process.pid}.jsonl`)), "2026-10-05");
};

describe("ScriptedIO, a careful user", () => {
  it("says yes when the page matches the booking it asked for", async () => {
    const io = user({ cls: "SL", date: "+1" });
    expect(await io.ask("Book it? The page says: book ticket (SL ₹160 11); Tue, 6 Oct, 2026.", "confirm")).toBe("haan");
    expect(io.objections).toEqual([]);
  });

  it("says no when the page shows another class, date or quota", async () => {
    expect(await user({ cls: "2S" }).ask("Book it? The page says: book ticket (SL ₹145 49).", "confirm")).toBe("no");
    expect(await user({ date: "+2" }).ask("Pay? The page says: Date Tue, 6 Oct, 2026.", "confirm")).toBe("no");
    const tatkal = user({ quota: "TQ" });
    expect(await tatkal.ask("Pay? The page says: Tue, 6 Oct, 2026 · SL · General Review.", "confirm")).toBe("no");
    expect(tatkal.objections).toEqual(["General quota, want Tatkal"]);
  });

  it("only judges the page's readback, not the model's own words", async () => {
    expect(await user({ cls: "SL" }).ask("Book a 3A ticket? The page says: book ticket (SL ₹160 11).", "confirm")).toBe("haan");
  });
});
