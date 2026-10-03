# Spike 1: microphone in the MV3 side panel

**Decision: GO. The side panel cannot show Chrome's mic prompt (confirmed in real Chrome on 2026-10-03), so the first mic grant must happen in an extension tab.** After that grant, the side panel captures audio normally. The flow works with VoiceOver, keyboard only, with every result read aloud. One trap for onboarding: Chrome's one-time "Allow this time" option.

- Code: `spikes/extension/ext/sidepanel.html`, `mic-test.js` and `permission.html`.
- `sidepanel.html` captures audio through the Drishti panel's own `pcm-capture.js` AudioWorklet.
- Run with `npx tsx spikes/extension/run.ts mic`.

## What was verified automatically

| Case | Result |
|---|---|
| Extension page, fake mic, prompt auto-accepted | ✅ 14 chunks of 100 ms (44.8 KB of 16 kHz PCM16) in 1.5 s. The AudioWorklet loads from the extension origin under the MV3 CSP, with a 48 kHz context downsampled by the worklet. |
| Extension page, fake mic, nobody answers the prompt | `NotAllowedError: Permission denied` after 3 ms, with no prompt shown |

So capture, the worklet and the PCM format all work inside an extension page; the panel's audio pipeline ports as-is. What automation cannot show is **whether Chrome displays the permission prompt inside the side panel**. Chrome has had issues where side-panel `getUserMedia` fails without showing a prompt.

The fallback is in the spike:
1. `permission.html` opens as a normal extension tab, which can show Chrome's prompt.
2. Once the extension origin is granted, the side panel uses the mic without a prompt.

## Manual check (you, about 3 minutes, real Chrome)

1. `npx tsx spikes/extension/run.ts snapshot` once (it copies `snapshot.js` into the extension), or copy `packages/core/src/snapshot.js` to `spikes/extension/ext/` by hand.
2. Open `chrome://extensions`, turn on Developer mode, choose **Load unpacked** and pick `spikes/extension/ext`.
3. Click the Drishti spike toolbar icon. The side panel opens.
4. Press **1. Test microphone here**. Record what happens: a prompt, `OK: {...}`, or `FAILED: NotAllowedError`.
5. If it failed, press **2**, allow the mic in the new tab, return to the panel, and press **1** again.
6. Repeat step 4 with VoiceOver on (Cmd+F5). Is the prompt, or the fallback tab, announced and usable?
7. Remove the extension afterwards.

### Outcome (2026-10-03, your Chrome on macOS)

| Step | Log |
|---|---|
| Button 1 in the side panel, first time | `permission before: prompt` → `FAILED: NotAllowedError: Permission dismissed` → `permission after: prompt`. **No prompt was ever shown.** |
| Button 2: grant in an extension tab | Prompt shown in the tab; allowed |
| Button 1 in the side panel again | `permission before: granted` → `OK: {"chunks":14,"bytes":44800,"peak":0.032,"ms":1642,"sampleRate":48000}` |

- Prompt shown in the side panel: **no**. Chrome dismisses it silently.
- Fallback tab worked: **yes**. After one grant, the side panel captures real mic audio through the Drishti worklet.
- VoiceOver usable: **yes**, keyboard only (VO keys).
  - The panel's live log region reads `FAILED` and `OK` aloud.
  - Both buttons and the grant tab are reachable, and Chrome's prompt can be answered without the mouse.

**VoiceOver pass:**
1. After resetting the grant, the first attempt *still failed* after allowing in the tab.
2. A retry worked: `permission before: granted` → `OK: {"chunks":15,"peak":0.128}` → `permission after: granted`, all read aloud.
3. Most likely cause of the failed attempt: Chrome's prompt offers **"Allow this time"** (one-time, revoked when the tab closes) next to **"Allow while visiting the site"**. The spike's grant tab closes itself 2.5 s after the grant, so a one-time allow is gone before the panel uses it. This is not confirmed: we didn't check which option was chosen.

**Decision: GO.** The extension-tab grant is **required**, not optional. Onboarding must send the first mic grant through a tab.

## Plan for Phase 2

- Onboarding routes the first mic grant through an extension tab with a spoken explanation. It is the only path that works, and it doubles as the consent screen.
- Check `navigator.permissions.query({ name: "microphone" })` when the panel opens. If it is `prompt` or `denied`, open the grant tab automatically, with a spoken explanation, instead of letting the user hit a silent failure.
- Detect `NotAllowedError` in the panel and speak a recovery instruction (via `chrome.tts`, since there is no mic).
- **The grant tab must not close itself.**
  - It speaks "When Chrome asks, choose *Allow while visiting the site*".
  - It stays open until the side panel reports a working capture, then closes.
  - If the permission is back at `prompt` after a grant, the panel says the allow was one-time and reopens the tab.
- Repeat this pass with NVDA on Windows before the beta (Phase 5).
