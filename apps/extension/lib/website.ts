/**
 * Drishti's website. Its connect page runs Turnstile (which can't run on an extension page),
 * gets a device token from the proxy, and hands it over with chrome.runtime.sendMessage.
 * Keep the origins in step with `externally_connectable` in wxt.config.ts.
 */
export const WEBSITE_ORIGINS = ["http://localhost:5175", "https://drishti.pages.dev"];

/** The local site until the real one is deployed; a release build sets WXT_WEBSITE. */
export const WEBSITE: string = import.meta.env.WXT_WEBSITE || WEBSITE_ORIGINS[0];

/** A device token: two base64url parts, nothing else. */
export const looksLikeToken = (t: unknown): t is string => typeof t === "string" && t.length < 512 && /^[\w-]+\.[\w-]+$/.test(t);

export function connectUrl(lang: string) {
  return `${WEBSITE}/connect.html?ext=${chrome.runtime.id}&lang=${encodeURIComponent(lang)}`;
}
