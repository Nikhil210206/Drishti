import type { Cache } from "./types.js";

/** In-memory Cache, for tests and short-lived sessions. */
export class MemoryCache implements Cache {
  private map = new Map<string, string>();
  async get(key: string) {
    return this.map.get(key);
  }
  async set(key: string, value: string) {
    this.map.set(key, value);
  }
}
