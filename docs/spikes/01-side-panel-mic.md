# Spike 1: microphone in the MV3 side panel

**Decision: GO, with the extension-tab permission fallback built in from day one.** One manual check by you is still needed to close the spike (below, about 3 minutes).

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

Write the outcome here:

- Prompt shown in side panel: _yes / no_
- Fallback tab worked: _yes / no_
- VoiceOver usable: _yes / no_

## Plan for Phase 2

- Onboarding always routes the first mic grant through an extension tab with a spoken explanation. It is the reliable path whatever the side panel does, and it doubles as the consent screen.
- Detect `NotAllowedError` in the panel and speak a recovery instruction (via `chrome.tts`, since there is no mic).
