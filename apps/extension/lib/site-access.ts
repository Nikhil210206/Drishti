/**
 * Drishti works on a site only after the user says so. The extension has host access up front
 * only for localhost (practice site, eval) and asks per site the first time a task needs a page:
 *
 *   "irctc.co.in: Drishti needs your permission to work on this website. Say yes or press Yes,
 *    then choose Allow in Chrome's box."
 *
 * Chrome grants host access only from a user gesture and shows its own Allow / Deny box, so a
 * spoken yes alone can't finish it: pressing Yes in the panel can (the click is the gesture), and
 * a spoken yes works when it comes soon enough after the Space press. Otherwise Drishti asks for
 * the button. The global Yes shortcut (Alt+Shift+Y) works from anywhere, the web page included:
 * the background asks Chrome straight from the key press. A grant covers the whole site (`*.irctc.co.in`), is remembered, and also lets the
 * agent move around that site. A no stops the task; the next request asks again.
 */
import { UserDeclinedError, yesNo, type BrowserDriver, type PhraseKey, type Snapshot } from "@drishti/core";

/** Second-level suffixes under which a site is three labels long (irctc.co.in, uidai.gov.in). */
const SECOND_LEVEL = new Set([
  "co.in",
  "gov.in",
  "nic.in",
  "org.in",
  "net.in",
  "ac.in",
  "edu.in",
  "res.in",
  "firm.in",
  "gen.in",
  "ind.in",
  "co.uk",
  "org.uk",
  "ac.uk",
  "com.au",
]);

/** The site a host belongs to: "www.irctc.co.in" → "irctc.co.in", "hi.wikipedia.org" → "wikipedia.org". */
export function siteOf(hostname: string): string {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (/^[\d.]+$/.test(h) || h.includes(":") || !h.includes(".")) return h;
  const labels = h.split(".");
  const n = SECOND_LEVEL.has(labels.slice(-2).join(".")) ? 3 : 2;
  return labels.slice(-n).join(".");
}

/** Chrome match patterns for a whole site, both schemes ("*.site" also matches "site" itself). */
export const sitePatterns = (site: string) => [`https://*.${site}/*`, `http://*.${site}/*`];

export interface SiteAccessDeps {
  /** Does the extension already have host access to these origins? */
  contains(origins: string[]): Promise<boolean>;
  /** Ask Chrome for host access (needs a user gesture; throws without one). */
  request(origins: string[]): Promise<boolean>;
  /**
   * Ask the user a yes/no question in the panel (voice, the Yes/No buttons, or the Yes shortcut,
   * which can ask Chrome for these origins itself: a shortcut press is a gesture too).
   */
  ask(question: string, origins: string[]): Promise<string | null>;
  say(key: PhraseKey): Promise<void>;
  phrase(key: PhraseKey): Promise<string>;
  /** A site was granted: allow it in the navigation policy and remember it. */
  granted(site: string): void;
}

export class SiteAccess {
  /** Sites refused during the current task: one no is enough, the same task doesn't ask twice. */
  private declined = new Set<string>();

  constructor(private deps: SiteAccessDeps) {}

  /** A new task: the user may say yes this time. */
  newTask() {
    this.declined.clear();
  }

  /** True when Drishti may act on this page, asking the user first if it has never been allowed. */
  async ensure(url: string): Promise<boolean> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return true; // about:blank, chrome:// and the like: nothing to ask about here
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return true;
    if (await this.deps.contains([`${u.protocol}//${u.hostname}/*`])) return true;
    const site = siteOf(u.hostname);
    if (this.declined.has(site)) return false;

    const question = `${site}: ${await this.deps.phrase("siteAccess")}`;
    const origins = sitePatterns(site);
    for (let attempt = 0; attempt < 2; attempt++) {
      const answer = await this.deps.ask(question, origins);
      if (answer === null || yesNo(answer) !== "yes") break;
      try {
        // Granted already (the Yes shortcut asked Chrome from the background)?
        if (await this.deps.contains(origins)) {
          this.deps.granted(site);
          return true;
        }
        // Straight after the yes, while the press of Yes (or of Space for a spoken yes) still counts.
        if (await this.deps.request(origins)) {
          this.deps.granted(site);
          return true;
        }
        break; // Deny in Chrome's box
      } catch {
        // No user gesture left: the spoken yes came too late. Ask for the button once.
        if (attempt === 0) await this.deps.say("pressYes");
      }
    }
    this.declined.add(site);
    await this.deps.say("siteDenied");
    return false;
  }
}

/** A BrowserDriver that asks for site access before touching a page. */
export class GatedDriver implements BrowserDriver {
  constructor(
    private inner: BrowserDriver,
    private access: () => SiteAccess,
  ) {}

  private async check() {
    const url = await this.inner.url();
    if (!(await this.access().ensure(url))) throw new UserDeclinedError(`The user did not allow Drishti on ${new URL(url).hostname}`);
  }

  async snapshot(): Promise<Snapshot> {
    await this.check();
    return this.inner.snapshot();
  }
  async signature() {
    await this.check();
    return this.inner.signature();
  }
  url() {
    return this.inner.url();
  }
  async click(id: string | number) {
    await this.check();
    return this.inner.click(id);
  }
  async type(id: string | number, text: string, submit?: boolean) {
    await this.check();
    return this.inner.type(id, text, submit);
  }
  async selectOption(id: string | number, option: string) {
    await this.check();
    return this.inner.selectOption(id, option);
  }
  async press(key: string) {
    await this.check();
    return this.inner.press(key);
  }
  async scroll(direction: "up" | "down") {
    await this.check();
    return this.inner.scroll(direction);
  }
  goBack() {
    return this.inner.goBack();
  }
  navigate(url: string) {
    return this.inner.navigate(url);
  }
  async focus(id: string | number) {
    await this.check();
    return this.inner.focus(id);
  }
  async readable() {
    await this.check();
    return this.inner.readable();
  }
  fetchBytes(url: string) {
    return this.inner.fetchBytes(url);
  }
}
