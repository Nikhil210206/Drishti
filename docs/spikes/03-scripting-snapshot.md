# Spike 3: page model through `chrome.scripting` on real sites

**Decision: GO.** `chrome.scripting.executeScript({ func: snapshotPage, allFrames: true })` runs the unchanged `packages/core/src/snapshot.js` in an MV3 service worker and returns the same page model as the Playwright harness. The spike found and fixed six page-model bugs that would have broken IRCTC, myScheme and iframes.

- Code: `spikes/extension/` (raw MV3 extension + Playwright runner). Run with `npx tsx spikes/extension/run.ts snapshot`.
- Results: `spikes/extension/results/snapshot*.json` (gitignored).
- Date: 2026-10-02, Chromium 1243 via Playwright 1.63.

## Results (headless, after fixes)

| Site | HTTP | Elements | Chars | Frames injected / with content | Extension ms | Playwright ms | Same text as Playwright | Inferred names |
|---|---|---|---|---|---|---|---|---|
| Pathik Rail (mock) | 200 | 18 | 881 | 1 / 0 | 12 | 9 | yes | 7 |
| Frames fixture (same- and cross-origin iframe) | 200 | 3 | 123 | 3 / 2 | 13 | 8 | yes | 0 |
| Hindi Wikipedia, भारत article | 200 | 220 (cap) | 9,330 | 1 / 0 | 50 | 36 | yes | 1 |
| IRCTC train search | blocked (HTTP/2 reset) | – | – | – | – | – | – | – |
| National Portal of India | 403 (Akamai) | 0 | 200 | 1 / 0 | 7 | 7 | yes | 0 |
| myScheme | 200 | 74 | 4,130 | 2 / 0 | 19 | 13 | yes | 1 |
| BBC Hindi | 200 | 93 | 10,210 | 12 / 0 | 33 | 19 | no (live page changed between calls) | 0 |

**Headed** Chromium loads IRCTC (language alert, then the booking form: 84 elements with station suggestions open) and india.gov.in (cookie-consent dialog detected as the open dialog). Both blocks are bot protection against headless browsers only.

## Findings

1. **Speed is a non-issue.** 7–50 ms per snapshot, including the message round trip to the service worker.
2. **`allFrames` reaches cross-origin iframes** that the Playwright path (`contentDocument`) cannot. Same-origin frames come back twice: once walked from the parent, once on their own.
   - The Phase 2 `ExtensionDriver` must merge by frame and skip frames the parent already walked.
   - It should also skip empty `about:blank` and ad frames. BBC Hindi injects into 12 frames, and none of them has content.
   - Clicking inside a frame needs the frame's offset for trusted (debugger) input; the spike did not do this.
3. **Headless Chromium is blocked by Akamai on IRCTC and india.gov.in.** Real users' Chrome is not headless, so this does not affect the product. CI and eval must use **saved copies** of these pages (already planned for Phase 1 fixtures). Live real-site checks must run headed.
4. **Six page-model bugs found and fixed** in `snapshot.js`, each with a regression test in `packages/core/test/snapshot.test.ts`:
   - Same-origin iframes were never walked. `instanceof Element` is false across realms, so every node inside an iframe counted as invisible. Fixed with `nodeType` checks and the frame's own `getComputedStyle`.
   - One unresolvable PDF link (`about:blank` base, malformed href) threw and killed the whole snapshot.
   - **IRCTC's whole booking form was missing.** Angular host elements (`app-jp-input`) are `display: inline` and measure 0×0, so the walker pruned everything inside them. Zero-size inline and `display: contents` wrappers are now walked through.
   - **IRCTC station suggestions were invisible.**
     - A `cursor: pointer` span wraps the input and its listbox, so the input and all 18 options collapsed into one "clickable" named after their concatenated text.
     - Rows also never descended into containers.
     - Now a pointer-cursor wrapper around form fields is not a control, rows descend like the main walk, and listboxes, menus and tablists are entered and not named by their children's text.
   - **myScheme showed only its accessibility panel.** An off-canvas `role="dialog"` at x=1360 in a 1280 px viewport was taken as the open modal. Off-screen dialogs and overlays are now ignored.
   - IRCTC's alert buttons have `aria-label`s containing a whole Angular error message plus HTML (about 400 characters). Names from `aria-label` and `aria-labelledby` are now clipped to 120 characters.
5. **The 220-element cap is hit on Wikipedia articles.** Fine for now, since `read_page` covers articles. Phase 1 should prioritise main-content and form controls over navigation when the cap bites.

## Follow-ups (Phase 1–2)

- Frame merge plus frame-offset clicking in `ExtensionDriver`.
- Save the IRCTC, india.gov.in and myScheme pages as fixtures for headless CI.
- Element-budget prioritisation (main and form before nav).
