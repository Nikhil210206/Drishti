import { afterEach, describe, expect, it, vi } from "vitest";
import { SttStream, TtsEngine } from "../src/index.js";

/** Sockets that open and close when the test says, like the browser's. */
function sockets() {
  const made: { fire: (type: string, e?: any) => void; sent: any[] }[] = [];
  const factory = () => {
    const sent: any[] = [];
    const listeners: Record<string, ((e: any) => void)[]> = {};
    const ws = {
      readyState: 0,
      send: (data: string) => sent.push(JSON.parse(data)),
      close() {},
      addEventListener: (type: string, fn: (e: any) => void) => (listeners[type] ??= []).push(fn),
    };
    const fire = (type: string, e: any = {}) => {
      if (type === "open") ws.readyState = 1;
      if (type === "close") ws.readyState = 3;
      listeners[type]?.forEach((fn) => fn(e));
    };
    made.push({ fire, sent });
    return ws as unknown as WebSocket;
  };
  return { made, factory };
}

const audio = () => new Uint8Array(3200);

afterEach(() => void vi.useRealTimers());

describe("SttStream through the proxy", () => {
  it("reconnects when there is audio to send, not by itself", () => {
    vi.useFakeTimers();
    const { made, factory } = sockets();
    const stt = new SttStream({ token: "t", baseUrl: "http://proxy", model: "saaras:v4", socket: factory });
    stt.connect();
    made[0].fire("open");
    made[0].fire("close", { code: 1000, reason: "session time limit" });
    vi.advanceTimersByTime(10 * 60_000);
    expect(made).toHaveLength(1); // a panel left open costs no quota
    stt.sendAudio(audio());
    expect(made).toHaveLength(2); // talking reconnects at once
    made[1].fire("open");
    expect(made[1].sent.filter((m) => m.event === "audio_input")).toHaveLength(1); // nothing lost
  });

  it("says why the proxy refused, and backs off instead of retrying forever", () => {
    vi.useFakeTimers();
    const { made, factory } = sockets();
    const statuses: string[] = [];
    const stt = new SttStream({ token: "t", baseUrl: "http://proxy", model: "saaras:v4", socket: factory });
    stt.on("status", (s, detail) => statuses.push(s === "refused" ? `refused ${detail}` : s));
    stt.connect();
    made[0].fire("open");
    made[0].fire("close", { code: 4429, reason: "quota" });
    expect(statuses).toContain("refused quota");

    stt.sendAudio(audio());
    expect(made).toHaveLength(1); // within the pause
    vi.advanceTimersByTime(60_000);
    expect(made).toHaveLength(1); // nobody talking: no tries at all
    stt.sendAudio(audio());
    expect(made).toHaveLength(2);
    made[1].fire("close", { code: 1006, reason: "" }); // a handshake that failed: a longer pause
    vi.advanceTimersByTime(1500);
    stt.sendAudio(audio());
    expect(made).toHaveLength(2);
    vi.advanceTimersByTime(600);
    stt.sendAudio(audio());
    expect(made).toHaveLength(3);
  });
});

describe("TtsEngine through the proxy", () => {
  it("fails the utterance with the proxy's reason when it refuses the socket", async () => {
    const { made, factory } = sockets();
    const tts = new TtsEngine({ token: "t", baseUrl: "http://proxy", model: "bulbul:v3", speaker: "kavya", socket: factory });
    const errors: string[] = [];
    tts.on("error", (e) => errors.push(e.message));
    const u = tts.speak("Okay, stopped.", "en-IN");
    await vi.waitFor(() => expect(made).toHaveLength(1));
    made[0].fire("open");
    await vi.waitFor(() => expect(made[0].sent.some((m) => m.type === "text")).toBe(true));
    made[0].fire("close", { code: 4429, reason: "quota" });
    await u.done;
    expect(errors).toEqual(["quota"]);
  });
});
