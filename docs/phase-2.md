# Phase 2 status: extension MVP and proxy (W6–8, 9–29 Nov 2026)

Started 2026-10-05, about five weeks ahead of schedule. The roadmap is in `~/.claude/plans/now-since-the-event-twinkly-pizza.md`; the Phase 0 spikes in `docs/spikes/` settled the risky parts (mic grant tab, stateless Worker relay, `chrome.scripting` snapshots, trusted debugger input).

**Exit:** a Pathik Rail booking and real-site reading work end to end in a normal Chrome profile through the proxy, and the Phase 1 targets still hold with `ExtensionDriver`.

## Work order

1. **`ExtensionDriver` and the eval through the extension** ✅ (below)
2. **Proxy** (`apps/proxy`, Cloudflare Worker, free plan):
   - Device tokens minted after a Turnstile check.
   - Relays for Saaras STT and Bulbul TTS (WebSockets; a browser can't send the key header) and for the LLM, Translate and Doc AI (REST).
   - Per-device daily quota in KV, a global rate-limit queue with a spoken "busy", no request bodies logged.
3. **Browser providers**: `packages/providers` without Node APIs (`ws`, `Buffer`, `fs`, `EventEmitter`), talking to the proxy with a device token or, for bring-your-own-key users, to Sarvam over REST from the service worker.
4. **Side panel**: the `packages/ui` panel moved into the extension, with the `VoiceSession` and agent running in the panel on `ExtensionDriver`.
5. **Onboarding**: the mic grant through an extension tab (spike 1), language, voice, consent, then a practice task on Pathik Rail. Optional profile in `chrome.storage.local`, deletable by voice.
6. **Per-site permission by voice** ("Allow Drishti on irctc.co.in?") with optional host permissions.
7. **Screen-reader output mode** (replies to an aria-live region) and keyboard shortcuts that don't clash with NVDA, JAWS or VoiceOver.
8. **Exit check**: real Chrome profile, through the deployed proxy.

## 1. `ExtensionDriver` ✅

- `apps/extension` is a WXT (MV3) build: background service worker, side panel (placeholder for now), Readability shipped for `read_page`.
  - Permissions: `scripting`, `debugger`, `tabs`, `sidePanel`, `storage`, `webNavigation`. Host access: localhost up front; everything else optional, to be asked per site.
- `apps/extension/lib/extension-driver.ts` implements `BrowserDriver`:
  - The page model is the unchanged `snapshot.js`, injected with `chrome.scripting`.
  - Clicks and typing are trusted `chrome.debugger` input (spike 4): mouse events at the element's centre; select-all, `Input.insertText`, then one real key event.
  - The debugger attaches for an action burst and detaches after 10 s idle, so Chrome's "debugging this browser" bar shows as little as possible. If the user cancels the bar, the driver stays on synthetic events for the session.
  - Synthetic DOM events are the fallback: when the debugger can't attach (`chrome://` pages, DevTools open), and when something covers the target (an open popup), as Playwright does.
  - It follows a new tab the page opens, and retries injection while a navigation is under way.
- `eval/lib/extension-bridge.ts` loads the built extension into Chromium and runs every driver call in its service worker. The agent stays in Node, so cassettes replay exactly as with Playwright.
  - `npm run eval:extension` (after `npm run build -w @drishti/extension`); `--input=synthetic` tests the fallback path.
  - CI now builds the extension and runs the replayed eval through it on every push, at no API cost.

**Result:** 40/40 replayed through the extension with trusted input, and 40/40 with synthetic events only, 0 safety incidents. Prompts are byte-identical to the Playwright runs (the one task with drift, `safety-decline-payment`, drifts the same with Playwright).

**Not done yet:** clicks inside cross-origin iframes (the frame offset), and merging snapshots from several frames (spike 3). Pathik Rail and the saved pages don't need them; real sites will.
