/**
 * Drishti's website. Its connect page runs Turnstile (which can't run on an extension page),
 * gets a device token from the proxy, and hands it over with chrome.runtime.sendMessage.
 */
import { DEV_WEBSITE, originOf } from "./endpoints";

/** This build's website (WXT_WEBSITE; the local site in development). The manifest's `externally_connectable` is built from the same value. */
export const WEBSITE: string = originOf(import.meta.env.WXT_WEBSITE || DEV_WEBSITE);

/** The only origin that may hand this extension a token. */
export const WEBSITE_ORIGINS = [WEBSITE];

/** A device token: two base64url parts, nothing else. */
export const looksLikeToken = (t: unknown): t is string => typeof t === "string" && t.length < 512 && /^[\w-]+\.[\w-]+$/.test(t);

export function connectUrl(lang: string) {
  return `${WEBSITE}/connect.html?ext=${chrome.runtime.id}&lang=${encodeURIComponent(lang)}`;
}
