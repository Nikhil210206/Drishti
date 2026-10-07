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
4. **Side panel** ✅: the `packages/ui` panel moved into the extension, with the `VoiceSession` and agent running in the panel on `ExtensionDriver`.
5. **Onboarding** ✅: the mic grant through an extension tab (spike 1), language, voice, consent, then a practice task on Pathik Rail. Optional profile in `chrome.storage.local`, deletable by voice.
6. **Per-site permission by voice** ✅ ("Allow Drishti on irctc.co.in?") with optional host permissions.
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

## 4. Side panel ✅

The extension now works as a product: the panel, the session and the agent all run in Chrome's side panel.

- **One panel, two hosts.** `useDrishti` takes a `PanelTransport`. The dev harness passes a WebSocket transport to its server. The extension passes `localTransport` (`apps/extension/lib/panel-session.ts`), which runs the `VoiceSession` in the panel itself. The protocol is the same, so the React panel is unchanged.
- **The panel builds the session:**
  - `ExtensionDriver` on the active tab of the panel's window; it follows the user to another tab and a page to a tab it opens.
  - The providers through the proxy with the device token.
  - Phrase translations kept in `chrome.storage.local` (fixed phrases only).
  - The navigation policy, unchanged.
- **Microphone:** the first `NotAllowedError` opens the grant tab (`permission.html`, spike 1).
  - It speaks and shows: choose "Allow while visiting the site".
  - It does not close itself, since a one-time grant would go with it. It closes when the panel reports the mic is capturing.
- **Developer setup screen:** until sign-in through the website exists, the panel asks for the proxy address and a device token.

**End to end** (`apps/extension/scripts/e2e.ts`): the built extension in Chromium, a typed command in the panel, the local proxy with a fresh token, Pathik Rail.

| Command | Task | Turns | Steps | Result |
|---|---|---|---|---|
| English | ✅ | 8 LLM calls, about 6 s of LLM time | – | the first three Mumbai–Pune trains for tomorrow, correctly |
| Hindi | ✅ in 9.5 s | – | 7 | the same, in Hindi; no panel errors |

The tab ended on the right results page each time. The replayed eval through the extension is still 40/40.

**Seen, for later:** the spoken replies run long (the Hindi one is about 50 s of speech, against the prompt's limit of three sentences). That needs tuning before the beta.

### Try it in your own Chrome

Superseded by the welcome flow: see "Try it" under step 5.

Worth checking with VoiceOver on:

- whether the panel, the grant tab and the debugging bar are announced and usable;
- whether the debugging bar steals focus while Drishti clicks (spike 4).

## 5. Onboarding ✅

**The welcome flow** (`welcome.html`, opened on install; the panel sends you there until setup is done) runs in a tab, because Chrome shows the mic prompt only in a tab (spike 1). Each step moves focus to its heading and speaks its instructions.

1. **Language**: 11 buttons with native names, the prompt spoken in English and Hindi.
2. **Connect**: opens the website's connect page (below). The page closes itself and the flow moves on when the token arrives.
3. **Privacy**: three plain points (what goes to Sarvam and why, what stays on the device, what Drishti never does), plus a link to the full page. "I agree" records the version and time. The panel won't start a session without the current version.
4. **Microphone**: Allow, then hold Test (or Space), speak, release. Drishti says what it heard. Choose "Allow while visiting the site".
5. **Voice**: speaker and speed, with a sample in the chosen language through Bulbul.
6. **Details (optional)**: name, age, gender and mobile, kept in `chrome.storage.local`.
7. **Practice**: opens the side panel and turns the tab into Pathik Rail.

**Language:** English and Hindi are hand-written. The other nine are machine-translated (Mayura) once connected, cached, and marked as such; they need a native-speaker review.

**The website** (`apps/website`, static, for Cloudflare Pages; `npm run website` serves it on port 5175):

- `connect.html`: Turnstile, usually with nothing to do, then the proxy mints a token, which goes straight to the extension that opened the page (`chrome.runtime.sendMessage`).
- The extension accepts it only from the origins in `externally_connectable`, and only if it looks like a token.
- The proxy allows CORS on `/v1/token` for those origins only (`WEBSITE_ORIGINS`).
- Also a landing page and a privacy draft. The privacy draft says plainly that Sarvam processes data under its own terms; checking those terms is listed for the public release.

**"Delete my details" by voice**, in all 11 languages (needs a native-speaker review):

- It is a quick command: a delete word plus a details word, in up to 6 words.
- It asks for a spoken yes first.
- Then the agent forgets the profile and the conversation, and the panel wipes the saved profile.

**A real bug found on the way: push-to-talk could lose the last utterance.**

- Saaras ends an utterance after 700 ms of silence, and its `flush` only works with manual endpointing.
- Releasing push-to-talk just stops the audio, so the server never heard the silence. A user who let go right after their last word got a late transcript, or none.
- The earlier tests padded silence themselves, so they never hit it.
- `SttStream.flush()` now sends a second of silence. This fixes the side panel too.

**A second bug:** a stray `mouseleave` (the button's label changing under a resting pointer) ended a Space-key hold. A hold now ends only through the input that started it.

**End to end** (`apps/extension/scripts/onboarding-e2e.ts`): a fresh install in Chromium, Chrome's fake microphone fed from the recorded Tamil clip, the real local website, Turnstile's test key and the local proxy. **9/9:**

| Check | Result |
|---|---|
| The flow opens on install | ✅ |
| Hindi chosen | ✅ |
| Connected through the website | ✅ |
| Consent recorded | ✅ |
| Mic test heard "வணக்கம். நாளை காலை சென்னையிலிருந்து பெங்களூருக்கு…" ("Hello. Tomorrow morning from Chennai to Bengaluru…") | ✅ |
| Voice saved | ✅ |
| Details saved on the device | ✅ |
| Practice site opened | ✅ |
| "मेरी जानकारी मिटा दो" ("delete my details") in the panel, then yes, removed the profile | ✅ |

**Not tested yet:** the machine-translated path for the other nine languages (about 35 strings, a few rupees the first time per language), and the whole flow with VoiceOver.

### Try it

1. `npm run dev -w @drishti/proxy -- --port 8788`
2. `npm run website`: the connect page at http://localhost:5175.
3. `npm run practice`: Pathik Rail at http://localhost:5174.
4. `npm run build -w @drishti/extension`. Then in `chrome://extensions`, turn on Developer mode, choose **Load unpacked**, and pick `apps/extension/.output/chrome-mv3`.
5. The welcome tab opens by itself. Follow it.


## 6. Per-site permission ✅

**What it does.** Drishti gets host access up front only for localhost (practice site, eval) and Sarvam's Doc AI storage. Every other site is asked about the first time a task needs one of its pages:

> irctc.co.in: Drishti needs your permission to work on this website. Say yes or press Yes, then choose Allow in Chrome's box.

The question uses the panel's usual yes/no card, so it works by voice or keyboard.

**Chrome rules shape it:**

- A site permission can only be requested from a user gesture, and Chrome shows its own Allow / Deny box.
- Pressing **Yes** (Enter or a click) asks Chrome on the spot: the press is the gesture.
- A spoken yes works when it comes soon enough after the Space press. If it doesn't, Drishti says "Please press Enter on the Yes button" and asks once more.

**What a yes covers:**

- The grant is for the whole site, both schemes (`*.irctc.co.in`).
- It is remembered (`settings.sites`) and added to the navigation policy, so the agent can also move around that site.
- Site names follow a small suffix list: `irctc.co.in`, `uidai.gov.in`, `wikipedia.org`.

**A no** ends the task quietly: "Okay. I won't work on this website.", with no generic error. It holds for that task only; the next request asks again.

**How:**

- `apps/extension/lib/site-access.ts`:
  - `SiteAccess` checks Chrome's permission for the page's exact host, then asks.
  - `GatedDriver` wraps `ExtensionDriver` and asks before reading or acting on any page. Navigating, going back and `url()` need no access.
- In core:
  - `NavigationPolicy.allow()`.
  - `UserDeclinedError`, which the session treats as a quiet stop.
  - The phrases `siteAccess`, `pressYes`, `siteDenied`.

**Tests:**

- 7 unit tests for the gate: site naming, already allowed, yes then Allow, no, a spoken yes too late, Deny in Chrome's box, a refused site never touched.
- A session test: a declined task ends without the error phrase.
- **End to end** (`apps/extension/scripts/site-access-e2e.ts`): Pathik Rail served as `http://practice.test:5174` (Chrome maps the name to localhost), a site the extension has no access to. **6/6:**

  | Check | Result |
  |---|---|
  | Drishti asks before working there | ✅ |
  | A no ends politely | ✅ |
  | The page was never read (0 elements tagged) | ✅ |
  | Nothing remembered as allowed | ✅ |
  | A new request asks again | ✅ |
  | Pressing Yes reaches Chrome as a user gesture: Chrome's own box opened rather than Drishti asking for the button | ✅ |

**Your manual check:** press **Allow** in Chrome's box and make sure the task carries on. Automation can't press Chrome's own dialogs.

**Not done yet:**

- A way to see and remove allowed sites (settings, or by voice: "stop using irctc.co.in").
- The agent still can't *open* a site that isn't allowed yet. It is blocked, as before; asking first belongs to the Phase 4 domain policy.
