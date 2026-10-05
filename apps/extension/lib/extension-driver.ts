/**
 * BrowserDriver for the user's own Chrome tab, from inside the extension.
 *
 * - The page model is the same `snapshot.js` the harness runs through Playwright, injected with
 *   chrome.scripting, so element ids and prompts are identical (spike 3).
 * - Clicks and typing use trusted chrome.debugger input by default: on real sites synthetic events
 *   sometimes do the wrong thing silently (spike 4). Synthetic events are the fallback when the
 *   debugger can't attach (chrome:// pages, DevTools open, the user cancelled the bar) and when
 *   something covers the target.
 * - The debugger attaches only for an action burst and detaches after a quiet spell, so Chrome's
 *   "started debugging this browser" bar is up as little as possible.
 *
 * Functions passed to executeScript are serialised, so each one is self-contained.
 */
import { snapshotPage } from "@drishti/core/snapshot.js";
import type { BrowserDriver, Snapshot, SnapshotOptions } from "@drishti/core";

export type InputMode = "debugger" | "synthetic";

export interface ExtensionDriverOptions {
  /** Trusted debugger input (default) or synthetic DOM events only. */
  input?: InputMode;
  /** Detach the debugger after this long without an action. */
  idleDetachMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Keys the agent presses, with their Windows virtual key codes (what CDP wants).
const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  PageDown: { code: "PageDown", keyCode: 34 },
  PageUp: { code: "PageUp", keyCode: 33 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  Space: { code: "Space", keyCode: 32, text: " " },
};
const MODIFIERS: Record<string, number> = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Shift: 8 };

export class ExtensionDriver implements BrowserDriver {
  private attached = false;
  /** The user cancelled the debugging bar: respect it for the rest of the session. */
  private debuggerRefused = false;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private input: InputMode;
  private idleDetachMs: number;

  constructor(
    public tabId: number,
    opts: ExtensionDriverOptions = {},
  ) {
    this.input = opts.input ?? "debugger";
    this.idleDetachMs = opts.idleDetachMs ?? 10_000;
    chrome.tabs.onCreated.addListener(this.onTabCreated);
    chrome.debugger.onDetach.addListener(this.onDetach);
  }

  /** Stop listening and let go of the tab. */
  async dispose() {
    chrome.tabs.onCreated.removeListener(this.onTabCreated);
    chrome.debugger.onDetach.removeListener(this.onDetach);
    await this.detach();
  }

  // A site that opens a new tab (a "print ticket" link, a payment page): follow it, as a sighted
  // user's attention would.
  private onTabCreated = (tab: chrome.tabs.Tab) => {
    if (tab.openerTabId !== this.tabId || tab.id === undefined) return;
    void this.detach();
    this.tabId = tab.id;
  };

  private onDetach = (source: chrome.debugger.Debuggee, reason: string) => {
    if (source.tabId !== this.tabId) return;
    this.attached = false;
    if (reason === "canceled_by_user") this.debuggerRefused = true;
  };

  // ---------- page model ----------

  async snapshot(opts: SnapshotOptions = {}): Promise<Snapshot> {
    await this.settle();
    return this.run(snapshotPage, opts) as Promise<Snapshot>;
  }

  async signature(): Promise<string> {
    return this.run(() => `${location.href}|${document.querySelectorAll("body *").length}`).catch(() => "");
  }

  async url(): Promise<string> {
    return (await chrome.tabs.get(this.tabId)).url ?? "";
  }

  // ---------- actions ----------

  async click(id: string | number) {
    const box = await this.run(pageBox, String(id));
    if (!box) throw new Error(`element [${id}] is not on the page any more`);
    // Something on top (an open popup) would take a trusted click: click the element itself.
    if (!box.covered && (await this.attach())) {
      await this.mouseClick(box.x, box.y);
    } else {
      await this.run(synthClick, String(id));
    }
    await this.afterAction();
  }

  async type(id: string | number, text: string, submit = false) {
    if (await this.attach()) {
      const r = await this.run(focusAndSelect, String(id));
      if (r !== "ok") throw new Error(`element [${id}] ${r}`);
      if (text) await this.cdp("Input.insertText", { text });
      else await this.key("Backspace");
      // Autocomplete widgets often wait for a real key event too.
      await this.key("End");
    } else {
      const r = await this.run(synthType, String(id), text);
      if (r !== "ok") throw new Error(`element [${id}] ${r}`);
    }
    if (submit) await this.press("Enter");
    else await this.afterAction();
  }

  async selectOption(id: string | number, option: string) {
    const r = await this.run(pageSelect, String(id), option);
    if (!r) throw new Error(`element [${id}] is not on the page any more`);
    if (r.kind === "missing") throw new Error(`No option like "${option}". Options: ${r.options.join(", ")}`);
    if (r.kind === "custom") {
      // A custom dropdown: open it, then click the visible option with that text.
      await this.click(id);
      await sleep(200);
      const pick = await this.run(markOption, option);
      if (!pick) throw new Error(`No visible option like "${option}"`);
      await this.click(pick);
      return;
    }
    await this.afterAction();
  }

  async press(key: string) {
    if (await this.attach()) await this.key(key);
    else await this.run(synthPress, key);
    await this.afterAction();
  }

  async scroll(direction: "up" | "down") {
    await this.run((dy: number) => window.scrollBy(0, dy), direction === "down" ? 600 : -600);
    await sleep(250);
  }

  async goBack() {
    await chrome.tabs.goBack(this.tabId).catch(() => {});
    await this.afterAction();
  }

  async navigate(url: string) {
    await chrome.tabs.update(this.tabId, { url });
    await sleep(100);
    await this.waitComplete(20_000);
    await this.afterAction();
  }

  async focus(id: string | number) {
    await this.run((i: string) => {
      const el = document.querySelector<HTMLElement>(`[data-drishti-id="${i}"]`);
      el?.focus();
    }, String(id)).catch(() => {});
  }

  async readable(): Promise<{ title: string; text: string }> {
    await chrome.scripting.executeScript({ target: { tabId: this.tabId }, files: ["/readability.js"] }).catch(() => {});
    return this.run(pageReadable);
  }

  async fetchBytes(url: string): Promise<Uint8Array> {
    // The extension's own fetch: host permission covers cross-origin, and cookies come along, so a
    // bill behind the user's login downloads like it would for them.
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`Download failed HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  // ---------- plumbing ----------

  /** Run a self-contained function in the tab's top frame; retries while a navigation is under way. */
  private async run<A extends unknown[], R>(func: (...args: A) => R, ...args: A): Promise<Awaited<R>> {
    let last: unknown;
    for (let i = 0; i < 20; i++) {
      try {
        const [r] = await chrome.scripting.executeScript({ target: { tabId: this.tabId }, func, args });
        return r?.result as Awaited<R>;
      } catch (e) {
        last = e;
        const msg = String((e as Error)?.message ?? e);
        // Not a navigation hiccup: give up straight away.
        if (/Cannot access|permission|No tab with id/i.test(msg)) throw e;
        await sleep(250);
      }
    }
    throw last;
  }

  private async settle() {
    await this.waitComplete(5000);
    await sleep(150);
  }

  private async afterAction() {
    await sleep(100);
    await this.waitComplete(5000);
    await sleep(300);
  }

  private async waitComplete(timeoutMs: number) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const tab = await chrome.tabs.get(this.tabId).catch(() => undefined);
      if (!tab || tab.status === "complete") return;
      await sleep(100);
    }
  }

  private async attach(): Promise<boolean> {
    if (this.input === "synthetic" || this.debuggerRefused) return false;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.detach(), this.idleDetachMs);
    if (this.attached) return true;
    try {
      await chrome.debugger.attach({ tabId: this.tabId }, "1.3");
      this.attached = true;
      return true;
    } catch {
      // chrome:// pages, the Web Store, or DevTools already attached.
      return false;
    }
  }

  private async detach() {
    clearTimeout(this.idleTimer);
    if (!this.attached) return;
    this.attached = false;
    await chrome.debugger.detach({ tabId: this.tabId }).catch(() => {});
  }

  private cdp(method: string, params: Record<string, unknown> = {}) {
    return chrome.debugger.sendCommand({ tabId: this.tabId }, method, params);
  }

  private async mouseClick(x: number, y: number) {
    await this.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  /** One trusted key press, e.g. "Enter", "Shift+Tab", "ArrowDown", "a". */
  private async key(combo: string) {
    const parts = combo.split("+");
    const name = parts.pop() ?? "";
    const modifiers = parts.reduce((m, p) => m | (MODIFIERS[p] ?? 0), 0);
    const k = KEYS[name];
    const text = k ? k.text : name.length === 1 && !(modifiers & ~8) ? name : undefined;
    const base = {
      key: k ? name : name,
      code: k?.code ?? (name.length === 1 ? `Key${name.toUpperCase()}` : name),
      windowsVirtualKeyCode: k?.keyCode ?? (name.length === 1 ? name.toUpperCase().charCodeAt(0) : 0),
      modifiers,
    };
    await this.cdp("Input.dispatchKeyEvent", {
      type: text ? "keyDown" : "rawKeyDown",
      ...base,
      ...(text ? { text, unmodifiedText: text } : {}),
    });
    await this.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }
}

// ---------- injected into the page (self-contained) ----------

/** Where to click an element (viewport CSS px), after scrolling it into view, and whether something covers it. */
function pageBox(id: string) {
  const el = document.querySelector<HTMLElement>(`[data-drishti-id="${id}"]`);
  if (!el) return null;
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  const x = r.x + r.width / 2;
  const y = r.y + r.height / 2;
  const top = document.elementFromPoint(x, y);
  const covered = !!top && top !== el && !el.contains(top) && !top.contains(el);
  return { x, y, covered: covered || r.width === 0 || r.height === 0 };
}

function synthClick(id: string) {
  const el = document.querySelector<HTMLElement>(`[data-drishti-id="${id}"]`);
  if (!el) return "missing";
  el.scrollIntoView({ block: "center" });
  el.focus?.();
  const opts = { bubbles: true, cancelable: true, composed: true, view: window, button: 0 };
  el.dispatchEvent(new PointerEvent("pointerdown", opts));
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  el.dispatchEvent(new PointerEvent("pointerup", opts));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.click();
  return "ok";
}

function focusAndSelect(id: string) {
  const el = document.querySelector<HTMLElement>(`[data-drishti-id="${id}"]`);
  if (!el) return "is not on the page any more";
  el.scrollIntoView({ block: "center" });
  el.focus();
  const input = el as HTMLInputElement;
  if (typeof input.select === "function") input.select();
  else document.execCommand("selectAll");
  return document.activeElement === el || el.contains(document.activeElement) ? "ok" : "could not be focused";
}

function synthType(id: string, text: string) {
  const el = document.querySelector<HTMLElement>(`[data-drishti-id="${id}"]`);
  if (!el) return "is not on the page any more";
  el.scrollIntoView({ block: "center" });
  el.focus();
  if (el.isContentEditable) {
    document.execCommand("selectAll");
    document.execCommand("insertText", false, text);
    return "ok";
  }
  // Frameworks track the value through the prototype setter.
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, text);
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  const key = text.slice(-1);
  el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
  el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key }));
  return "ok";
}

function synthPress(key: string) {
  const el = (document.activeElement as HTMLElement | null) ?? document.body;
  const name = key.split("+").pop() ?? key;
  for (const type of ["keydown", "keyup"]) el.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, key: name }));
  if (name === "Enter") (el as HTMLInputElement).form?.requestSubmit();
}

/** Set a native <select> by its option text; say so when it is a custom dropdown instead. */
function pageSelect(id: string, option: string) {
  const el = document.querySelector<HTMLElement>(`[data-drishti-id="${id}"]`);
  if (!el) return null;
  if (el.tagName !== "SELECT") return { kind: "custom" as const, options: [] as string[] };
  const select = el as HTMLSelectElement;
  const labels = Array.from(select.options).map((o) => o.text.trim());
  const want = option.toLowerCase();
  const i = [
    labels.findIndex((l) => l.toLowerCase() === want),
    labels.findIndex((l) => l.toLowerCase().includes(want)),
    labels.findIndex((l) => want.includes(l.toLowerCase())),
  ].find((n) => n >= 0);
  if (i === undefined) return { kind: "missing" as const, options: labels };
  select.selectedIndex = i;
  select.dispatchEvent(new Event("input", { bubbles: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
  return { kind: "native" as const, options: labels };
}

/** The last visible element whose own text contains the option: tag it so it can be clicked. */
function markOption(option: string) {
  const want = option.toLowerCase().trim();
  const all = Array.from(document.querySelectorAll<HTMLElement>("body *")).filter((el) => {
    if (!(el.innerText ?? "").toLowerCase().includes(want)) return false;
    // The innermost match only: not every ancestor that also contains the text.
    if (Array.from(el.children).some((c) => ((c as HTMLElement).innerText ?? "").toLowerCase().includes(want))) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  });
  const el = all[all.length - 1];
  if (!el) return null;
  let id = el.getAttribute("data-drishti-id");
  if (!id) {
    id = `pick-${Date.now()}`;
    el.setAttribute("data-drishti-id", id);
  }
  return id;
}

function pageReadable() {
  const w = window as unknown as { Readability?: new (doc: Document) => { parse(): { title?: string; textContent?: string } | null } };
  try {
    if (typeof w.Readability === "function") {
      const art = new w.Readability(document.cloneNode(true) as Document).parse();
      if (art?.textContent && art.textContent.trim().length > 200) {
        return { title: art.title || document.title, text: art.textContent.replace(/\s+/g, " ").trim() };
      }
    }
  } catch {}
  return { title: document.title, text: (document.body?.innerText || "").replace(/\s+/g, " ").trim() };
}
