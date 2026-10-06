/**
 * Node-only pieces, kept out of the main entry so the extension bundle never pulls in `ws`, `fs`
 * or `crypto`: sockets that send the key as a header (dev harness, eval) and the phrase-audio disk
 * cache.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import WS from "ws";
import type { AudioCache } from "./sarvam/tts.js";
import type { SocketFactory } from "./sarvam/key.js";

/** A socket with the key in a header (or a device token as the subprotocol, like the browser). */
export const nodeSocket: SocketFactory = (url, auth) =>
  (auth.token
    ? new WS(url, ["drishti", auth.token])
    : new WS(url, { headers: { "api-subscription-key": auth.apiKey ?? "" } })) as unknown as WebSocket;

/** Fixed phrases on disk, in `<dir>/tts-phrases/<sha1>.pcm`. Only ever given fixed phrases. */
export class FileAudioCache implements AudioCache {
  private dir: string;

  constructor(cacheDir: string) {
    this.dir = path.join(cacheDir, "tts-phrases");
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private file(key: string) {
    return path.join(this.dir, `${crypto.createHash("sha1").update(key).digest("hex")}.pcm`);
  }

  async get(key: string) {
    const f = this.file(key);
    return fs.existsSync(f) ? new Uint8Array(fs.readFileSync(f)) : undefined;
  }

  async set(key: string, pcm: Uint8Array) {
    fs.writeFileSync(this.file(key), pcm);
  }
}
