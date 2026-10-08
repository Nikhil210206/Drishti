/**
 * The Drishti proxy and website a build talks to. A release build sets them at build time:
 *
 *   WXT_PROXY=https://drishti-proxy.<account>.workers.dev WXT_WEBSITE=https://<site>.pages.dev npm run build -w @drishti/extension
 *
 * Without them: the local development servers. Read by wxt.config.ts (the manifest) and by the
 * extension itself, so the two can't disagree.
 */
export const DEV_PROXY = "http://localhost:8788";
export const DEV_WEBSITE = "http://localhost:5175";
/** Pathik Rail from the dev harness (`npm run practice`), with the server the eval checks bookings on. */
export const DEV_PRACTICE = "http://localhost:5174/";

/** The practice site: the website's copy (apps/website/scripts/build.ts), or the dev harness's locally. */
export const practiceUrl = (website: string) => (website === DEV_WEBSITE ? DEV_PRACTICE : `${website}/practice/`);

/** The origin of an http(s) address ("https://x.workers.dev/" → "https://x.workers.dev"). */
export function originOf(url: string): string {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`Not a web address: ${url}`);
  return u.origin;
}

/**
 * Host access for the proxy (any port): the extension's own requests to it then skip CORS, which
 * the proxy doesn't answer (only the website's connect page gets CORS, for minting).
 */
export function hostPermission(origin: string): string {
  const u = new URL(origin);
  return `${u.protocol}//${u.hostname}/*`;
}
