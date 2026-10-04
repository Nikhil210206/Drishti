import { describe, expect, it } from "vitest";
import { costMeter, parseArgs, recoverToolCalls, stripThink } from "../src/index.js";

describe("tool-call recovery", () => {
  it("recovers a call written into the text body", () => {
    const calls = recoverToolCalls('<think>hmm</think>```json\n{"name": "click", "arguments": {"id": 9, "narration": ""}}\n```');
    expect(calls).toEqual([{ id: "rec_0", name: "click", args: { id: 9, narration: "" } }]);
  });

  it("recovers several calls from a JSON array", () => {
    const calls = recoverToolCalls(
      '[{"name":"type_text","arguments":"{\\"id\\":3,\\"text\\":\\"Chennai\\"}"},{"name":"done","args":{"speech":"ok"}}]',
    );
    expect(calls.map((c) => c.name)).toEqual(["type_text", "done"]);
    expect(calls[0].args).toEqual({ id: 3, text: "Chennai" });
  });

  it("ignores plain speech", () => {
    expect(recoverToolCalls("Namaste! Main aapki kya madad karun?")).toEqual([]);
  });
});

describe("parseArgs", () => {
  it("accepts objects, JSON strings and JSON wrapped in prose", () => {
    expect(parseArgs({ a: 1 })).toEqual({ a: 1 });
    expect(parseArgs('{"a":1}')).toEqual({ a: 1 });
    expect(parseArgs('Here you go: {"a":1} thanks')).toEqual({ a: 1 });
    expect(parseArgs("garbage")).toEqual({});
    expect(parseArgs(undefined)).toEqual({});
  });
});

describe("stripThink", () => {
  it("removes reasoning blocks", () => {
    expect(stripThink("<think>secret plan</think> Hello")).toBe("Hello");
  });
});

describe("cost meter", () => {
  it("bills cached prompt tokens at the cached rate", () => {
    const t0 = costMeter.total;
    costMeter.addLlm({ prompt_tokens: 1_000_000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 750_000 } });
    expect(costMeter.total - t0).toBeCloseTo(250_000 * (29.28 / 1e6) + 750_000 * (10.98 / 1e6), 6);
  });

  it("treats a missing cache report as uncached", () => {
    const t0 = costMeter.total;
    costMeter.addLlm({ prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: null });
    expect(costMeter.total - t0).toBeCloseTo(1000 * (29.28 / 1e6) + 100 * (73.2 / 1e6), 9);
  });
});
