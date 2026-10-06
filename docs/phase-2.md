# Phase 2 status: extension MVP and proxy (W6–8, 9–29 Nov 2026)

Started 2026-10-05, about five weeks ahead of schedule. The roadmap is in `~/.claude/plans/now-since-the-event-twinkly-pizza.md`; the Phase 0 spikes in `docs/spikes/` settled the risky parts (mic grant tab, stateless Worker relay, `chrome.scripting` snapshots, trusted debugger input).

**Exit:** a Pathik Rail booking and real-site reading work end to end in a normal Chrome profile through the proxy, and the Phase 1 targets still hold with `ExtensionDriver`.

## Work order

1. **`ExtensionDriver` and the eval through the extension** ✅ (below)
2. **Proxy** ✅ built and tested locally; deploying it is your step (`docs/proxy.md`). `apps/proxy`, Cloudflare Worker, free plan:
   - Device tokens minted after a Turnstile check.
   - Relays for Saaras STT and Bulbul TTS (WebSockets; a browser can't send the key header) and for the LLM, Translate and Doc AI (REST).
   - Per-device daily quota (in D1, not KV: see below), a global rate limit with a "busy" reply, no request bodies logged.
3. **Browser providers** ✅: `packages/providers` without Node APIs (`ws`, `Buffer`, `fs`, `EventEmitter`), talking to the proxy with a device token or, for bring-your-own-key users, to Sarvam over REST from the service worker.
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

## 2. Proxy ✅ (local)

Details, setup and deploy steps: `docs/proxy.md`.

- **Paths:** the same as `api.sarvam.ai`, for exactly the endpoints Drishti uses: chat, translate, Doc AI digitise/status/download-url, and the STT and TTS sockets. Anything else is a 404, so providers only swap base URL and credential.
- **Device tokens:** stateless HMAC tokens (no storage read to check one), minted after Turnstile, 5 a minute per IP, valid a year. Rotating `TOKEN_SECRET` revokes them all.
- **Sockets:** carry the token as a subprotocol, never in the URL, so it can't land in request logs. Messages pass through unchanged, and a socket closes after 15 minutes.
- **Limits:**
  - Per-device daily quota of 400 units, about 40 tasks.
  - Per-device bursts capped at 60 a minute.
  - LLM calls capped at 40 a minute for all users together (Sarvam's starter limit), answered with `busy`.
- **Change from the plan: the quota lives in D1, not KV.** KV's free plan allows 1,000 writes a day, which one write per request would exhaust with a handful of users; D1 allows 100,000.
- **Privacy:**
  - Observability is off; nothing reads, stores or logs bodies.
  - Only `content-type` goes up with the key, so cookies, IPs and the caller's token never reach Sarvam.
  - Only `content-type` comes back.
- **Tests:**
  - 11 unit tests: tokens, routing, auth, quota, busy, size limits, what gets forwarded.
  - A smoke test against real Sarvam through `wrangler dev`, 7/7: Tamil STT through the relay, TTS first audio at 0.34 s, translate, chat, refusals.
  - The real D1 counted 5 units per run, as designed.

**Open:**

- ~~Doc AI's download URL points at Sarvam's storage.~~ Settled in step 3: the extension fetches it directly.
- The Turnstile widget needs the website (a later step). Until then, tokens for testing are minted by hand (`apps/proxy/scripts/mint.ts`).

## 3. Browser providers ✅

`packages/providers` now runs in the extension as well as in Node.

- **Two ways to reach Sarvam, per client:**
  - `apiKey`: straight to Sarvam (dev harness, eval, bring-your-own-key).
  - `token` + `baseUrl`: through the proxy (the extension).
- **Sockets:** opened by a factory. In the browser the device token is the subprotocol. Node keeps the `ws` package with the key in a header (`nodeSocket`).
- **Node-only code moved out:**
  - A typed `Emitter` replaces `node:events`.
  - `Uint8Array` and base64 helpers replace `Buffer`.
  - Phrase audio is cached behind an `AudioCache` interface: a disk folder in Node (`FileAudioCache`); packaged audio or IndexedDB in the extension later.
  - Doc AI uses the REST API directly, so the `sarvamai` SDK, temp files and `fs` are gone.
  - The Node-only pieces live in `@drishti/providers/node`. A test keeps Node APIs out of the main entry, and the browser bundle builds (35 KB).
- **Proxy refusals become a `LimitError`** (`busy`, `quota`, `slow_down`, `unauthorized`), for the panel to speak:
  - The LLM waits out `busy` (retry-after 5 s).
  - It stops at once on `quota`.
- **Checks:**
  - **Through the proxy, with the browser code path** (device token, the standard `WebSocket`, no key; `apps/proxy/scripts/providers.ts`), 5/5:

    | Check | Result |
    |---|---|
    | Translate | ✅ |
    | Chat | ✅ |
    | TTS | first audio at 0.45 s |
    | STT (Tamil) | final transcript 0.86 s after the audio ended |
    | Doc AI on a printed one-page bill | the amount read correctly |

  - **Directly, with the Node path** (key in the socket header): the harness check passes for LLM tool calls, TTS, STT and translate.
  - The replayed eval is still 40/40.
- **Doc AI's result is a signed link on Sarvam's Azure storage** (`appsprodaksharpublicsa.blob.core.windows.net`). The extension gets host permission for exactly that host and fetches it directly, so bills never pass through our proxy. If Sarvam moves the storage, the fallback is a streaming route on the proxy.

**Not done yet:** bring-your-own-key speech. A browser can't send the key on a socket (spike 2), so those users need REST speech-to-text per utterance. That's Phase 3 work with the fallback providers.
