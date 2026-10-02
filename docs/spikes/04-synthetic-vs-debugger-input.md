# Spike 4: content-script synthetic events vs `chrome.debugger` trusted input

**Decision: use trusted `chrome.debugger` input as the default on real sites.** Keep synthetic events as the fallback when the debugger can't attach, and as the fast path on Pathik Rail and fixtures. This flips the plan's draft order ("content-script first, debugger only when an action has no observable effect"): on real sites the synthetic path sometimes has *the wrong* effect rather than no effect, and a diff check can't always tell.

- Code: `spikes/extension/ext/background.js` (`synthClick`/`synthType` versus `Input.dispatchMouseEvent`, `Input.insertText` and per-key `Input.dispatchKeyEvent`).
- Run with `HEADED=1 npx tsx spikes/extension/run.ts actions`.
- Date: 2026-10-02, headed Chromium (IRCTC refuses headless; see spike 3).

## Results

| Site / step | Synthetic | Debugger, `insertText` | Debugger, per-key |
|---|---|---|---|
| Pathik Rail: typing FROM shows suggestions | ✅ | ✅ | ✅ |
| Pathik Rail: clicking a suggestion fills FROM | ✅ | ✅ | ✅ |
| Pathik Rail: search reaches the results page | ✅ | ✅ | ✅ |
| Pathik Rail: typed passenger name reaches app state | ✅ | ✅ | ✅ |
| Hindi Wikipedia: typing shows suggestions (23 new options) | ✅ | ✅ | ✅ |
| Hindi Wikipedia: clicking the suggestion "भारत दक्षिण एशिया का देश" | ❌ **opened the Main Page** | ✅ opened भारत | ✅ opened भारत |
| myScheme: clicking the "Enter scheme name to search…" opener reveals the input | ❌ nothing happens | ✅ | ✅ |
| myScheme: typing sets the value and the site reacts | – (no input) | ✅ | ✅ |
| IRCTC: dismissing the language/Aadhaar alert | ✅ | ✅ | ✅ |
| IRCTC: typing "CHENNAI" in From shows 18 station suggestions | ✅ | ✅ | ✅ |
| IRCTC: clicking a suggestion | ✅ | ✅ | ✅ |

"Value set ❌" on Wikipedia in all modes is a spike artefact: the Vue widget replaces the input element, so the old id is gone.

## Findings

1. **Synthetic events can do the wrong thing silently.**
   - On Wikipedia the same option, clicked synthetically, navigated to the Main Page. The Codex menu acts on real pointer sequences, and our synthetic `mousedown` probably blurred the input first.
   - A "did the page change?" check would have passed. For a blind user that is worse than a failure.
2. **Some widgets only open on trusted clicks** (myScheme's search opener).
3. **IRCTC (Angular + PrimeNG) works with all three methods** once the page model sees the suggestions (fixed in spike 3).
   - Before the fix, every method *looked* broken. Page-model bugs and input bugs are easy to confuse, so the eval traces in Phase 1 must record both the DOM and the snapshot.
4. **Per-key typing did not beat `insertText` anywhere tested.** Keep `insertText` plus one trusted key event. It is faster and handles Indic text without keyboard-layout issues.
5. **Costs of `chrome.debugger`:**
   - Chrome shows a "Drishti started debugging this browser" bar while attached.
   - **It must be tested with NVDA, JAWS and VoiceOver** (does the bar steal focus or announcements?). Phase 2 should attach only during an action burst and detach after.
   - The Web Store needs a justification for the permission. Accessibility automation is an accepted reason; state it in the listing.
   - The debugger cannot attach to `chrome://` pages, the Web Store, or tabs another debugger holds (DevTools open). Fall back to synthetic there.

## Design for `ExtensionDriver` (Phase 2)

- `click`: trusted mouse events at the element centre (after `scrollIntoView`), with a synthetic fallback.
- `type`: trusted click into the field, select all, `Input.insertText`, then one trusted key event.
- Verify every action by diffing the snapshot, as the agent already does. On "no change", retry once with the other method.
- Attach lazily and detach after about 10 s idle.
