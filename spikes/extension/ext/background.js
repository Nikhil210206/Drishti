// Spike service worker. The runner (spikes/extension/run.ts) calls `self.drishti.*` through
// Playwright; a person can use the side panel instead.
import { snapshotPage } from "./snapshot.js";

chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

const attached = new Set();
async function cdp(tabId, method, params = {}) {
  if (!attached.has(tabId)) {
    await chrome.debugger.attach({ tabId }, "1.3");
    attached.add(tabId);
  }
  return chrome.debugger.sendCommand({ tabId }, method, params);
}
chrome.debugger.onDetach.addListener((src) => attached.delete(src.tabId));

const inPage = async (tabId, frameId, func, args = []) => {
  const [res] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId ?? 0] }, func, args });
  return res?.result;
};

// ---------- functions injected into the page (must be self-contained) ----------
function pageFind(id) {
  const el = document.querySelector(`[data-drishti-id="${id}"]`);
  if (!el) return null;
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, tag: el.tagName };
}

function synthClick(id) {
  const el = document.querySelector(`[data-drishti-id="${id}"]`);
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

function synthType(id, text) {
  const el = document.querySelector(`[data-drishti-id="${id}"]`);
  if (!el) return "missing";
  el.scrollIntoView({ block: "center" });
  el.focus();
  if (el.isContentEditable) {
    document.execCommand("selectAll");
    document.execCommand("insertText", false, text);
    return "ok";
  }
  // React and other frameworks track the value through the prototype setter.
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  const key = text.slice(-1);
  el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
  el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key }));
  return "ok";
}

function focusAndSelect(id) {
  const el = document.querySelector(`[data-drishti-id="${id}"]`);
  if (!el) return "missing";
  el.scrollIntoView({ block: "center" });
  el.focus();
  if (typeof el.select === "function") el.select();
  else document.execCommand("selectAll");
  return "ok";
}

function readValue(id) {
  const el = document.querySelector(`[data-drishti-id="${id}"]`);
  return el ? (el.value ?? el.textContent) : null;
}

// ---------- API used by the runner ----------
self.drishti = {
  async snapshotAll(tabId, opts = {}) {
    const t0 = performance.now();
    const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: snapshotPage, args: [opts] });
    const ms = Math.round(performance.now() - t0);
    const frames = await chrome.webNavigation?.getAllFrames({ tabId }).catch(() => null);
    return {
      ms,
      frames: results.map((r) => ({
        frameId: r.frameId,
        documentId: r.documentId,
        url: r.result?.url ?? null,
        chars: r.result?.text?.length ?? 0,
        elements: r.result ? Object.keys(r.result.elements).length : 0,
        error: r.error ? String(r.error.message ?? r.error) : null,
      })),
      frameCount: frames?.length ?? null,
      main: results.find((r) => r.frameId === 0)?.result ?? null,
    };
  },
  async snapshot(tabId, frameId = 0, opts = {}) {
    const [r] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func: snapshotPage, args: [opts] });
    return r?.result;
  },
  value: (tabId, frameId, id) => inPage(tabId, frameId, readValue, [String(id)]),
  async click(tabId, frameId, id, mode) {
    if (mode === "synthetic") return inPage(tabId, frameId, synthClick, [String(id)]);
    // "debugger" and "debugger-keys" both click with trusted mouse events.
    const box = await inPage(tabId, frameId, pageFind, [String(id)]);
    if (!box) return "missing";
    if (frameId) return "iframe-offset-not-handled";
    await new Promise((r) => setTimeout(r, 120)); // let scrollIntoView settle
    const again = await inPage(tabId, frameId, pageFind, [String(id)]);
    const { x, y } = again ?? box;
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    return "ok";
  },
  async type(tabId, frameId, id, text, mode) {
    if (mode === "synthetic") return inPage(tabId, frameId, synthType, [String(id), text]);
    if (mode === "debugger-keys") {
      // Click into the field first (some widgets only open on a real click), then one trusted
      // key event per character, like a real keyboard.
      await self.drishti.click(tabId, frameId, id, "debugger");
      const r = await inPage(tabId, frameId, focusAndSelect, [String(id)]);
      if (r !== "ok") return r;
      await cdp(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
      await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
      for (const ch of text) {
        await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch });
        await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: ch });
        await new Promise((res) => setTimeout(res, 40));
      }
      return "ok";
    }
    const r = await inPage(tabId, frameId, focusAndSelect, [String(id)]);
    if (r !== "ok") return r;
    await cdp(tabId, "Input.insertText", { text });
    // Autocomplete widgets often wait for a real key event too.
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: "End", code: "End", windowsVirtualKeyCode: 35 });
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "End", code: "End", windowsVirtualKeyCode: 35 });
    return "ok";
  },
  async detach(tabId) {
    if (attached.has(tabId)) await chrome.debugger.detach({ tabId }).catch(() => {});
    attached.delete(tabId);
  },
};
