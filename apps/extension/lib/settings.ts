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
  /** Bulbul voice and speaking pace. */
  speaker: string;
  pace: number;
  /** The privacy summary the user agreed to, and when. Nothing goes to Sarvam before this. */
  consent?: { version: string; at: string };
  /** Sites the user let Drishti work on (Chrome host access granted), e.g. "irctc.co.in". */
  sites?: string[];
  /** The welcome flow is finished. */
  onboarded?: boolean;
}

/** Bump when the privacy summary changes: users see it again. */
export const CONSENT_VERSION = "2026-10-07";

const DEFAULTS: Settings = { proxyUrl: "http://localhost:8788", token: "", homeUrl: "http://localhost:5174/", speaker: "kavya", pace: 1.1 };

/** Ready to talk to Sarvam: connected, and the user agreed to the current privacy summary. */
export const ready = (s: Settings) => !!s.token && s.consent?.version === CONSENT_VERSION;

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
