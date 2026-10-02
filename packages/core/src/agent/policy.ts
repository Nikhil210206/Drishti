/**
 * Which sites Drishti may open. One policy covers every way of getting somewhere: the
 * agent's navigate tool, clicked links, the panel's home button, redirects and new tabs.
 * Domains match exactly or as a parent domain ("wikipedia.org" allows "hi.wikipedia.org",
 * never "evilwikipedia.org" or "wikipedia.org.evil.com").
 */
export const DEFAULT_ALLOWED_DOMAINS = ["localhost", "127.0.0.1", "wikipedia.org", "gov.in", "bbc.com"];

export class NavigationPolicy {
  private domains: string[];

  constructor(domains: string[] = DEFAULT_ALLOWED_DOMAINS) {
    this.domains = domains.map((d) => d.toLowerCase().replace(/^\.+|\.+$/g, ""));
  }

  hostAllowed(hostname: string): boolean {
    const h = hostname.toLowerCase().replace(/\.$/, "");
    return this.domains.some((d) => h === d || h.endsWith(`.${d}`));
  }

  /** Only http(s) URLs on an allowed domain. */
  allows(url: string, base?: string): boolean {
    try {
      const u = new URL(url, base);
      if (u.protocol !== "http:" && u.protocol !== "https:") return false;
      if (u.username || u.password) return false;
      return this.hostAllowed(u.hostname);
    } catch {
      return false;
    }
  }
}

/** Where a link would navigate to, or "" when it stays on the page (#hash, javascript:, mailto:, tel:). */
export function linkTarget(href: string, base: string): string {
  if (!href) return "";
  try {
    const u = new URL(href, base);
    if (["javascript:", "mailto:", "tel:"].includes(u.protocol)) return "";
    const b = new URL(base);
    if (u.origin === b.origin && u.pathname === b.pathname && u.search === b.search) return ""; // same page, hash only
    return u.href;
  } catch {
    return "";
  }
}
