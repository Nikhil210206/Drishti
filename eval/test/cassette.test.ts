import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatOptions, LLM } from "@drishti/core";
import { Cassette } from "../lib/cassette.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const tmpFile = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "drishti-cassette-"));
  dirs.push(d);
  return path.join(d, "task.json");
};
const req = (content: string): ChatOptions => ({ messages: [{ role: "user", content }], toolChoice: "required", reasoning: "none" });
const fake = (): LLM & { n: number } => ({
  n: 0,
  async chat() {
    this.n++;
    return {
      content: "",
      toolCalls: [{ id: "c", name: "done", args: { speech: `reply ${this.n}` } }],
      ms: 5,
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    };
  },
});

describe("Cassette", () => {
  it("replays recorded replies in order without calling the model", async () => {
    const file = tmpFile();
    const live = fake();
    const rec = new Cassette(file, "record", "t", "m");
    const llm = rec.llm(live);
    await llm.chat(req("a"));
    await llm.chat(req("b"));
    rec.save();

    const offline = fake();
    const play = new Cassette(file, "replay", "t", "m");
    const r1 = await play.llm(offline).chat(req("a"));
    expect(r1.toolCalls[0].args.speech).toBe("reply 1");
    expect(offline.n).toBe(0);
  });

  it("counts drift when a prompt changed, and reports exhaustion", async () => {
    const file = tmpFile();
    const rec = new Cassette(file, "record", "t", "m");
    await rec.llm(fake()).chat(req("a"));
    rec.save();
    const play = new Cassette(file, "replay", "t", "m");
    const llm = play.llm(fake());
    await llm.chat(req("changed prompt"));
    expect(play.drift).toBe(1);
    await expect(llm.chat(req("one more"))).rejects.toThrow("cassette exhausted");
    expect(play.exhausted).toBe(true);
  });

  it("replays translations by content and notes missing ones", async () => {
    const file = tmpFile();
    const rec = new Cassette(file, "record", "t", "m");
    await rec.translator({ translate: async (t, to) => `${to}:${t}` }).translate("Okay, stopped.", "ta-IN");
    rec.save();
    const play = new Cassette(file, "replay", "t", "m");
    const tr = play.translator({ translate: async () => "SHOULD NOT BE CALLED" });
    expect(await tr.translate("Okay, stopped.", "ta-IN")).toBe("ta-IN:Okay, stopped.");
    expect(await tr.translate("Something new", "ta-IN")).toBe("Something new");
    expect(play.missing).toHaveLength(1);
  });

  it("refuses to replay a task that was never recorded", () => {
    expect(() => new Cassette(path.join(os.tmpdir(), "nope", "x.json"), "replay", "x", "m")).toThrow("Record it with --live");
  });
});
