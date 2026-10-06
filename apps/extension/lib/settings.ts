/**
 * What the extension keeps on the user's device, in chrome.storage.local. Nothing here leaves the
 * device except the device token, which goes to the Drishti proxy.
 */
import type { Cache, LangCode, Profile } from "@drishti/core";

export interface Settings {
  /** Drishti proxy origin. */
  proxyUrl: string;
  /** Device token from the proxy (minted after Turnstile; by hand during development). */
  token: string;
  lang?: LangCode;
  /** Pathik Rail practice site. */
  homeUrl: string;
  profile?: Profile;
}

const DEFAULTS: Settings = { proxyUrl: "http://localhost:8788", token: "", homeUrl: "http://localhost:5174/" };

export async function loadSettings(): Promise<Settings> {
  const s = (await chrome.storage.local.get("settings")).settings as Partial<Settings> | undefined;
  return { ...DEFAULTS, ...s };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

/** Phrase translations (fixed UI phrases, never user content), kept across sessions. */
export class StorageCache implements Cache {
  constructor(private prefix: string) {}
  async get(key: string) {
    const k = this.prefix + key;
    return (await chrome.storage.local.get(k))[k] as string | undefined;
  }
  async set(key: string, value: string) {
    await chrome.storage.local.set({ [this.prefix + key]: value });
  }
}
