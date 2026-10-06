import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TtsEngine } from "../src/index.js";
import { FileAudioCache } from "../src/node.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function engine() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drishti-tts-"));
  dirs.push(dir);
  const tts = new TtsEngine({ apiKey: "test", model: "bulbul:v3", speaker: "kavya", cache: new FileAudioCache(dir) });
  let synthesised = 0;
  // No network: pretend Bulbul returned a little audio.
  (tts as any).synthesize = async () => {
    synthesised++;
    return [new Uint8Array(480)];
  };
  const files = () => fs.readdirSync(path.join(dir, "tts-phrases"));
  return { tts, files, count: () => synthesised };
}

describe("TtsEngine disk cache", () => {
  it("never writes ordinary speech to disk", async () => {
    const { tts, files } = engine();
    await tts.speak("Your PNR is 4123456789, coach S4 berth 23", "en-IN").done;
    expect(files()).toEqual([]);
  });

  it("caches fixed phrases and replays them without synthesising again", async () => {
    const { tts, files, count } = engine();
    await tts.speak("Okay, stopped.", "en-IN", { cache: true }).done;
    expect(files()).toHaveLength(1);
    await tts.speak("Okay, stopped.", "en-IN", { cache: true }).done;
    expect(count()).toBe(1);
  });

  it("caches nothing without a cache directory", async () => {
    const tts = new TtsEngine({ apiKey: "test", model: "bulbul:v3", speaker: "kavya" });
    (tts as any).synthesize = async () => [new Uint8Array(480)];
    await expect(tts.speak("Okay, stopped.", "en-IN", { cache: true }).done).resolves.toBeUndefined();
  });
});
