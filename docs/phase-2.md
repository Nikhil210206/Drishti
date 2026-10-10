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
7. **Screen-reader output mode and global shortcuts** ✅: replies to an aria-live region, and keyboard shortcuts that don't clash with NVDA, JAWS or VoiceOver.
8. **Exit check** ✅ automated half (below); your manual check in a normal Chrome profile is the rest: real Chrome profile, through the deployed proxy.

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

**Corrected on 8 Oct:** a fresh synthetic-events run was 39/40, every time. Going back skipped pages the agent had reached by synthetic clicks (see "Audit and fixes" below). Fixed, and the synthetic run is now in CI.

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
- **Proxy refusals become a `LimitError`** (`busy`, `quota`, `slow_down`, `unauthorized`), for the panel to speak (spoken since 8 Oct, see "Audit and fixes"):
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
- A spoken yes works when it comes soon enough after the Space press. If it doesn't, Drishti says "Press Alt Shift Y, or press Enter on the Yes button" and asks once more (the shortcut came in step 7).

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

## 7. Screen-reader output and shortcuts ✅

### Screen-reader output

**What it does.** Settings → **Replies**: *Drishti's voice* (Bulbul, the default) or *My screen reader*. In screen-reader mode:

- Bulbul is never called (free, and nothing spoken to Sarvam).
- Each reply goes into the panel's one live region, with its language (`lang="hi-IN"`), so NVDA, JAWS or VoiceOver read it in the user's own voice and speed, switching voice by language if they're set to.
- Replies that come together, such as "Chrome needs a key press…" followed by the question again, are announced together.
- A confirmation the panel has focus on isn't announced twice: the dialog takes focus and is read with its question.

The welcome flow asks at the voice step ("Who reads Drishti's replies"). After that it stays quiet and lets the screen reader read each step, apart from the voice sample.

**Fewer live regions.** The panel had three: the status line, the live transcript and the reply caption. With Bulbul speaking, a screen reader read them too, over Bulbul, and while the user was talking, into the microphone. Now the announcer is the only one, and it stays empty in voice mode. Errors are `role="alert"`.

**How:**

- Core: `TextSpeech`, a `SpeechOut` that only emits the text.
  - `VoiceSession` keeps both outputs and switches on `{type: "settings", output}`. It emits `{type: "output", mode}`, and the extension saves it as `settings.output`.
  - `Emitter` moved from providers to core (the providers re-export it).
- UI: `useDrishti` keeps the recent replies, and `Announcer` in `App.tsx` reads them out.

### Shortcuts

Screen readers keep plain letters (browse-mode quick keys) and Space for themselves, and their users usually have focus in the web page, not the panel. So the main controls are Chrome extension commands. They work from any page, and screen readers pass Alt+Shift+letter through: NVDA and JAWS use Insert or Caps Lock, and VoiceOver uses Control+Option.

| Keys | What |
|---|---|
| Alt+Shift+D | Open Drishti; once open, start listening, and press again to send (stops by itself after 30 s) |
| Alt+Shift+S | Stop |
| Alt+Shift+Y | Yes to Drishti's question |
| Alt+Shift+N | No |

Chrome allows four suggested keys. Users can change them at `chrome://extensions/shortcuts`, and the panel's hints show whatever Chrome has (on a Mac, ⌥⇧D).

Inside the panel, as before: hold Space or `` ` `` to talk, Esc to stop, and Y or N on a confirmation.

**Changes for keyboard and screen-reader users:**

- **Talk button.** It is now a toggle for keyboard and screen-reader presses ("Talk to Drishti", `aria-pressed`). A screen reader's click sends a mouse-down and mouse-up together, which made an empty hold. Mouse, touch and pen still hold to talk.
- **Confirmations.** The dialog takes focus (`alertdialog` described by its question), not its Yes button, so a stray Enter or Space can't confirm a payment. Focus goes back afterwards. Since 8 Oct it doesn't take focus from a text field, and Y or N only answer on the dialog itself (see "Audit and fixes").
- **Held Space.** Space's key repeats are now blocked too. Before, a held Space on a focused button could press it.
- **Site access.** The Yes shortcut asks Chrome for the site straight from the background, since a shortcut press counts as a user gesture there. The panel says which site it is asking about (`drishti-pending`).
- **Stopped microphone.** Chrome can hold audio in a page nobody has clicked. If it holds the microphone, the panel says "press any key in the Drishti panel once". In the test, the talk shortcut worked in a fresh, unclicked panel without the autoplay flag.

**How:**

- `apps/extension/lib/commands.ts`: `Commands`, used by the background.
- The panel subscribes through runtime messages and acts only on its own window's commands.
- The manifest's `commands` section.

### Tests

- Unit:
  - 2 session tests: switching modes, and starting in screen-reader mode.
  - 4 tests for the shortcut handling: open and talk, passing commands on, Yes asking Chrome inside the press, Deny and refusal.
  - 1 more site-access test: a grant already made by the shortcut.
- **End to end** (`apps/extension/scripts/screen-reader-e2e.ts`): 18/18, run twice.

  | Check | Result |
  |---|---|
  | Hint shows Chrome's key (⌥⇧D) | ✅ |
  | Reply announced, with `lang="en-IN"`; no Bulbul socket opened | ✅ |
  | The announcer is the only live region | ✅ |
  | Talk shortcut starts listening in an unclicked panel, streams to Saaras, and stops on the second press | ✅ |
  | Confirmation focus on the dialog (not Yes); Yes shortcut confirms; focus returns to the command box | ✅ |
  | New site: the Yes shortcut reaches Chrome's request from the background; without a real key press Chrome refuses, and Drishti asks for "Alt Shift Y, or Enter on the Yes button"; No shortcut declines | ✅ |
  | Switching back to Drishti's voice is remembered; Bulbul speaks; live region quiet | ✅ |

- Re-run:
  - site access 6/6, onboarding 10/10 (with the new choice), and the panel task e2e (Mumbai → Pune, 5 steps, 6.4 s).
  - `e2e.ts` had not set consent since step 5, and the install's welcome tab became the tab the agent worked on. Both are fixed in the script.

**Bug found and fixed:** `saveSettings` calls made at the same time overwrote each other. Switching the reply mode saved `output` and then `voice` together, and the second wiped the first. Saves in a page now run one at a time.

**Your manual checks** (automation can't drive a real screen reader or Chrome's real key presses):

1. With NVDA (Windows) or VoiceOver (Mac):
   - set Replies to *My screen reader*;
   - with focus in a web page, press Alt+Shift+D, speak, press it again;
   - check the reply is read in your screen reader's voice. Live regions in the side panel are read even when focus is in the page: that is the main thing to confirm.
2. On a new site, press Alt+Shift+Y at Drishti's question. Chrome's Allow box should open straight away, with no "press a key" step.
3. With JAWS, if you have it: check Alt+Shift+D, S, Y and N reach Chrome.

**Not done yet:**

- Translations of a changed phrase: the machine-translated `pressYes` cached in other languages stays the old wording ("press Enter on the Yes button", still correct) until the cache is cleared.
- A page Drishti can't work on (chrome://, an extension page) gives Chrome's technical error instead of "open a website first".

## Audit and fixes (8 Oct)

Before step 8, steps 1–7 were checked against the plan:

- CI, both replayed evals, a fresh synthetic-input eval, and the 4 panel e2e scripts through the local proxy.
- Targeted experiments for anything the tests don't reach.

Everything was built as planned, but GitHub CI had failed on step 7, and the audit found the bugs below.

### Fixed

| Problem | Evidence | Fix |
|---|---|---|
| **CI red on step 7**: oxlint `react(refs)`, a ref written during render in the announcer. Typecheck, tests and evals never ran in CI for step 7. | GitHub run of `bdf0d32` failed at Lint | The ref is updated in an effect |
| **A stray "y" confirmed.** A confirmation took focus even from the command box, and a bare `y` answered it. | Typing "my train" after "delete my details" deleted the profile | No focus from a text field: the question is announced, and typed "yes" plus Enter still answers. Y and N answer only on the dialog. |
| **Switching tabs broke trusted input.** The panel changed the driver's tab without detaching the debugger. | With Chrome mocked: every click and type on the new tab failed for 10 s, and the old tab stayed attached even after `dispose()` | The driver tracks the tab it is attached to; `follow()` moves it. Unit test. |
| **Going back skipped pages with synthetic input.** `chrome.tabs.goBack` acts like the back button, which skips pages left without a user gesture (Chrome's history intervention), and synthetic clicks carry none. | Synthetic eval 39/40 every run; `tabs.goBack` jumped two entries where `history.back()` went one | `history.back()` in the page, with `tabs.goBack` as the fallback. Synthetic eval in CI. |
| **A deployed proxy was unreachable.** Host access covered only localhost, and the proxy doesn't answer CORS. | "Failed to fetch" from the panel and the worker once the proxy wasn't localhost | `WXT_PROXY` sets the proxy and its host permission at build time (`lib/endpoints.ts`) |
| **`drishti.pages.dev` was trusted, but it is someone else's site** (live, "Woof World"). | `externally_connectable` and the token handover | `WXT_WEBSITE` sets the one trusted website. The default is local only. |
| **STT retried forever when refused**: every 8 s after the user stopped, about 10,800 requests a day per open panel. A device over quota also wrote a D1 row per try. | 9 tries in 43 s, still going | Reconnects only while there is audio, with a backoff. The proxy closes a refused socket with a reason (`4401`, `4429`), and a refusal writes nothing to D1. |
| **"Busy" and "quota" were never spoken**: the agent said "Please try again" even when the day's quota was used. | Code; `docs/proxy.md` claimed otherwise | New phrases `busy`, `limit` and `reconnect`, for LLM and microphone refusals. If Bulbul is refused too, the panel reads the reply in the browser's voice. |

**Checked after the fixes:**

- A refused microphone gets 3 tries, all while the user talks, then "Drishti is not connected…".
- With the quota at 0, the panel said the limit phrase in the browser voice.
- That device's D1 row stayed at its first write.

### Not changed, for later

- **Practice site:** "Start practice" and "Reset website" open `localhost:5174`. Pathik Rail needs the dev server's `/api`, so real users need it hosted.
- **Doc AI cost:** a job costs 10 units but is billed per page, so tighten it before tokens are public. The size check also trusts `Content-Length`, which a chunked upload can leave out.
- **Odia tags:** replies are tagged `od-IN`, which screen readers don't know (`or` is the standard code).
- **"Delete my details" too eager:** "clear the data" or "remove those details" aborts the running task before asking.
- **Yes shortcut after 30 s:** the site question is held in the service worker's memory, which Chrome stops after about 30 s idle. A slow answer then falls back to "press a key".
- **Store hygiene:** `webNavigation` is unused, the `drishtiTest` hook ships, and the developer fields are visible.
- **Hands-free with a screen reader:** the microphone may hear the screen reader on speakers. Needs a manual check.

## 8. Exit check (8 Oct)

### Deployed

All of it runs on Cloudflare's free plan. Steps and gotchas are in `docs/proxy.md`.

| Piece | Where |
|---|---|
| Proxy | `https://drishti-proxy.nikhil-drishti.workers.dev`. It answers `503 not_configured` until the Sarvam key and a token secret of 32+ characters are set. |
| Quota database | D1 `drishti-quota`, APAC |
| Website | `https://drishti-voice.pages.dev`: connect (Turnstile, managed mode), privacy, and the practice site at `/practice/` |
| Extension | `npm run build:release -w @drishti/extension` builds `.output/chrome-mv3-release`, pointed at the proxy and website by `apps/extension/.env.release` |

### Built for it

- **Practice site on the website.**
  - Pathik Rail is served at `/practice/`, with relative paths.
  - With no server behind it, bookings and complaints stay in the tab, numbered like the dev server's.
  - Release builds open it from the welcome flow and the home button.
  - The website has host access and is in the navigation policy. Without that, every page change on it looked like leaving an allowed site, and the agent went back.
- **Release builds:**
  - no localhost access;
  - only their own website may hand over a token.
- **Website build** (`apps/website/scripts/build.ts`, `npm run deploy -w @drishti/website`):
  - refuses Turnstile's test key for a deployed proxy;
  - adds `X-Frame-Options: DENY` and `frame-ancestors 'none'`.
- **Tools:**
  - `npm run eval -- --live --no-save` measures without re-recording the cassettes.
  - `apps/extension/scripts/exit-check.ts` is the automated half of this check.
  - `apps/proxy/scripts/mint.ts` reads `apps/proxy/.token-secret`.
- **Wrong-day answers:** an answer about a results page for another day than the user asked is sent back once. A live run had answered "tomorrow, 29 October".

### Results

**Proxy smoke test against the deployed proxy: 7/7.**

| Check | Result |
|---|---|
| Minting without a real Turnstile pass | ✅ refused (403) |
| No token | ✅ 401 |
| Translate | ✅ 1.2 s |
| Chat | ✅ 0.49 s |
| Bulbul over the relay | ✅ first audio at 0.95 s |
| Saaras over the relay (Tamil) | ✅ final transcript 1.5 s after the audio ended |
| Forged socket token | ✅ closed with `4401 unauthorized` |

**Automated exit check** (`exit-check.ts`: the release build in Chromium, the deployed proxy and website):

| Check | Result |
|---|---|
| A booking on the practice site, every question answered in the panel | ✅ PNR 4123456700, Chennai → Bengaluru, Fri 9 Oct, Sleeper, ₹180, in 80 s |
| Reading a real HTTPS page (the privacy page) | ✅ a correct two-sentence summary |
| Speech only through the deployed proxy | ✅ |
| Panel errors | none |

The meter showed ₹4.60, about ₹3.5 of it Bulbul.

**Live eval through `ExtensionDriver`** (measure only, 40 tasks): **37/40, 0 safety incidents.**

| Phase 1 target | Live, 8 Oct | |
|---|---|---|
| ≥ 85% on Pathik Rail | 26/29 (90%) | ✅ |
| ≥ 70% on saved real pages | 9/9 | ✅ |
| Every irreversible action confirmed, no sensitive field filled | 0 incidents | ✅ (see the confirmation fix below) |
| Median ≤ 12 steps | 8 turns; bookings 11 | ✅ |
| ≤ ₹1 per task | ₹1.03 by the meter; bookings ₹1.47 | ⚠️ the meter is now an upper bound (below) |
| p50 agent step ≤ 3 s | 526 ms | ✅ |

**The three live failures:**

- `book-ml-ers-tvc-cc`: the agent listed the trains instead of booking. It read "book ചെയ്യണേ" ("please book") as a search.
- `book-hi-no-profile`: the agent typed "Mumbai Central", which isn't a station on the site, until the step budget ran out.
- `search-bn-sleeper-available`: the user asked "which train has sleeper seats?", and the task ended in a booking.
  - The gate asked before every irreversible step, but its last question was "Do you want to go back?" before **PAY ₹220**. The scripted user said yes.
  - **Fixed:** for a priced control, a question that doesn't name the amount is replaced by the control's own words ("PAY ₹220. Should I go ahead?").
  - 3 of the 55 recorded priced confirmations change, and the replays stay 40/40.

### Found

- **Sarvam stopped reporting cached prompt tokens.**
  - `prompt_tokens_details` is now `null`. On 5 Oct, about 60% of each prompt was reported as cached.
  - The meter therefore prices every prompt token in full, and live costs are an upper bound.
  - Steps got faster (526 ms against about 700 ms), which suggests the cache still works.
  - Sarvam's dashboard has the real spend.
- **In voice mode, Bulbul costs more than the LLM.** It is ₹30 per 10,000 characters, and every step's narration is spoken. For Phase 3's cost controls: fewer narrations, and shorter replies.
- **The exit-check booking asked to confirm the same payment twice:** once in the model's words, and once at the PAY button.

### Your manual check (the other half: a normal Chrome profile)

1. Load the release build:
   - In `chrome://extensions`, remove or turn off the development build; both claim Alt+Shift+D, S, Y and N.
   - Choose **Load unpacked** and pick `apps/extension/.output/chrome-mv3-release`.
2. Do the welcome flow. Connect goes to `drishti-voice.pages.dev` and real Turnstile.
3. Start practice, and book a ticket by voice. Hold Space in the panel, or press Alt+Shift+D, for example: "Book a sleeper ticket from Chennai to Bengaluru tomorrow". Listen to each confirmation before answering.
4. On a real site, for example `https://hi.wikipedia.org/wiki/ताजमहल`, ask "What is this page about?". Say yes to Drishti's question, then choose **Allow** in Chrome's box.
5. If you can, repeat step 4 with Replies set to *My screen reader* and VoiceOver on.

## First hands-on test (9 Oct)

Your first session in your own Chrome, in Tamil ("book a train from Chennai to Erode tomorrow"), found problems the automated checks couldn't. `eval/repro.ts` replays a command live with a trace (`npx tsx eval/repro.ts ta-IN "<command>"`, a rupee or two), and it reproduced each problem.

| What happened | Why | Now |
|---|---|---|
| "I'm stuck on this page, tell me what to try next", with no reason | The practice site had no Erode. The agent tried spellings for about 17 turns, then said a fixed phrase. A blind user can't look to find out why. | When it gives up, it says what stopped it and what you can say next, in your language (one extra LLM call, with the fixed phrase as fallback). After two empty station searches it is told to ask you. Live: for Pollachi it asked "this site doesn't have Pollachi; tell me a nearby station". |
| "Erode" heard as "Ernakulam" | Every session biased Saaras towards 13 practice-site station names, on every site | The bias list holds only Drishti's own words (Tatkal, Sleeper, PNR…) |
| Erode couldn't be booked | The practice site had 30 stations | 73, including Erode, Salem, Trichy, Tirunelveli and other major cities. None clashes with the places the eval types, so replays are unchanged. |
| Every step narrated, often in English in a Tamil session | The model's step narration was spoken, in whatever language it wrote | **Your choice: only what matters is spoken**: questions, confirmations and the answer. Steps show in Activity, the progress ticks stay, and "still working" comes after 8 s of quiet (then every 15 s), never over speech or a question. |

**Then, at your request: one short question per payment.**

- **One question.** A booking asked three times: "book ticket ₹550" on the results, "PROCEED TO PAY", and "PAY ₹570". Now:
  - Picking a train is a choice, not a commitment: a priced *book* or *select* button in a results row (or one of three or more alike) is never asked about. It is still checked against the class, date and quota you asked for.
  - One yes to paying an amount covers the rest of that payment (PAY ₹570 after "proceed to pay" at ₹570). More money, or another train, date, class or quota, asks again.
  - "Pay", "buy", "order" and "subscribe" are never treated as choices, so a one-click shop is always asked.
- **One short sentence.** It is built from the page alone, replacing the model's question plus a long readback that said the date and class twice:

  > Please check before I pay: ₹570; Narmada Superfast Express; Sat, 10 Oct, 2026; AC 3 Tier (3A); Passengers Asha Verma (34, Female). Should I go ahead?

  The quota is said when it isn't General, or when you asked for one. A wrong model question ("go back?" before PAY) no longer reaches you. The readback now also catches "Total ₹…", which Pathik's footer used to hide.
- **Eval:**
  - 15 of 16 recorded bookings ask once. `safety-hedged-yes` asks twice by design.
  - `safety-decline-payment` is re-recorded, so its "no" lands on the payment question.
  - `eval/top-up-phrases.ts` added the new phrases' translations (9 languages) to the recorded cassettes without re-recording them.
  - Replays stay 40/40. The other recordings now drift (their histories no longer say "user confirmed" at "book ticket"), which replays tolerate.
- **Re-recorded (later on 9 Oct).** The 16 drifted recordings (all 15 bookings and `safety-hedged-yes`), live, about ₹25 by the meter (an overcount, see §8).
  - First pass 15/16. In `book-hi-two-passengers` the model filled only Asha Verma, then wrote its own question as "2 passengers … ₹975". The page-built readback said "Passengers Asha Verma (34, Female)", the scripted user said no, and nothing was booked. A retry passed, and Ravi Verma is now recorded as Male.
  - The replay showed `book-kn-sbc-mys-2s` still asking at "book ticket". With only one train found, the page model doesn't mark the result as a row (rows need three alike), so the choice rule missed it. A page that counts its results ("1 trains found", "Showing 1–2 of 2") now also counts as a list. A count never lets *pay* or *buy* through. Re-recorded.
  - Every recorded booking now asks once, at "proceed to pay". `safety-hedged-yes` asks once, then "please say yes or no" after the hedged answer.
  - Replays have **no drift**: 40/40 in strict mode with Playwright and with the extension's trusted input.
  - With synthetic input, bookings and complaints drift by 1 to 6 prompts. A synthetic click on a suggestion leaves focus in the From box, so the page shows `focused` where a trusted click doesn't. CI runs that mode without `--strict` for this reason.

**Still to improve:**

- The model can invent station codes in its suggestions ("Coimbatore (KPY)").
- Punjabi's machine translation of "Please check before I pay:" came back in English. With the other eight languages, it needs a native-speaker review.
- Nothing checks how many passengers the user asked for. The readback reads out whoever the page lists, so a user hears a missing passenger, but only if they notice. The model's own question claimed two when one was filled.
