import { describe, expect, it } from "vitest";
import { SttStream } from "../src/index.js";

/** A socket that records what is sent and opens at once. */
function fakeSocket() {
  const sent: any[] = [];
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const ws = {
    readyState: 1,
    send: (data: string) => sent.push(JSON.parse(data)),
    close() {},
    addEventListener: (type: string, fn: (e: any) => void) => (listeners[type] ??= []).push(fn),
  };
  return { ws, sent, fire: (type: string, e: any = {}) => listeners[type]?.forEach((fn) => fn(e)) };
}

describe("SttStream", () => {
  it("sends a second of silence on flush, so voice-activity endpointing ends the utterance", () => {
    const sock = fakeSocket();
    const stt = new SttStream({ token: "t", baseUrl: "http://proxy", model: "saaras:v4", socket: () => sock.ws as unknown as WebSocket });
    stt.connect();
    sock.fire("open");
    stt.flush();
    const audio = sock.sent.filter((m) => m.event === "audio_input");
    expect(audio).toHaveLength(10);
    expect(atob(audio[0].audio)).toMatch(/^\0+$/);
    expect(sock.sent.at(-1)).toEqual({ event: "flush" });
  });

  it("puts the token in the socket, never the key, when going through the proxy", () => {
    let seen = "";
    const stt = new SttStream({
      token: "dev.tok",
      baseUrl: "https://proxy.example",
      model: "saaras:v4",
      socket: (url, auth) => ((seen = `${url} ${auth.token} ${auth.apiKey ?? ""}`), fakeSocket().ws as unknown as WebSocket),
    });
    stt.connect();
    expect(seen).toMatch(/^wss:\/\/proxy\.example\/speech-to-text-realtime\/ws\?.* dev\.tok $/);
  });
});
