# Drishti (दृष्टि) — a voice-first web agent for blind Indians

Screen readers make blind users step through a website one element at a time, and they're English-first. Indian sites are full of unlabelled icons, `div` buttons and colour-only indicators, so booking a train ticket can take hundreds of keystrokes.

**With Drishti, you say what you want in any of 11 Indian languages.** It operates the website for you, reads the options back in your language, and asks for a spoken "yes" before anything irreversible.

> "Chennai se Bangalore, kal subah ki train" ("a train from Chennai to Bangalore, tomorrow morning") → Drishti searches, reads out the top 3 trains, fills in passenger details, and pauses at payment: "₹845 pay karein?" ("Pay ₹845?")

## Built on Sarvam

| Piece | Sarvam product | How it's used |
|---|---|---|
| Listening | **Saaras v4** realtime STT | Streaming WebSocket, `language_code=auto` detects the language of each utterance, `keyterms` biases towards station names |
| Thinking | **Sarvam-105B** | Tool-calling browser agent: reasoning `low` on the first step of a task, off for later steps to keep them fast |
| Speaking | **Bulbul v3** streaming TTS | Raw PCM stream for low latency; 11 languages; adjustable speed ("faster" / "slower"); disk cache |
| Documents | **Sarvam Vision** (Doc AI digitise) | Reads PDF bills and letters (23 languages); starts reading as soon as a document link appears |
| Translation | **Mayura / Sarvam Translate** | Reads page text aloud word for word in the user's language; generates the multilingual fixed phrases |
| Dictation | **Kivi** | "Drishti navigates, Kivi writes": the user dictates long text (complaints, messages) with Kivi, Drishti reads it back aloud and fills the form after the user approves |

## What makes it work

- **Page model** (`packages/core/src/snapshot.js`) — turns any page into a numbered outline of about 300–900 tokens. It **infers names for unlabelled controls** from icon classes and nearby visual labels, names **colour-only indicators** such as `(colour: green)`, collapses repeated cards into single rows, and detects unmarked modal overlays.
- **Deterministic safety gate** (`packages/core/src/agent/safety.ts`) — the model cannot skip it:
  - Pay, submit, send and delete always need a spoken yes in any of the 11 languages.
  - Drishti never types passwords, OTPs, card numbers or Aadhaar numbers.
  - It never attempts a CAPTCHA.
  - Page content is treated as untrusted, which defends against prompt injection.
  - Navigation is restricted to an allowlist of sites, whether the agent navigates, clicks a link, gets redirected or a new tab opens (`packages/core/src/agent/policy.ts`).
- **Voice UX** — push-to-talk or hands-free, interrupting Drishti mid-speech, earcons for every state, narration spoken while each action runs, and a latency HUD.
- **Pathik Rail** (`fixtures/pathik-rail`) — a fictional train-booking site that is inaccessible on purpose. Add `?a11y=good` for the accessible version.

## Run it

```bash
npm install
npx playwright install chromium
cp .env.example .env   # add SARVAM_API_KEY
npm run check          # smoke-test every Sarvam API (TTS → STT loopback, 105B tool call, translate)
npm run dev            # panel http://localhost:5173 · agent browser opens on the right
npm test               # unit tests (safety, policy, agent, session, page model in headless Chromium)
npm run ci             # lint + format check + typecheck + tests, same as GitHub Actions
npm run eval           # 40 end-to-end agent tasks replayed from eval/cassettes (free, offline)
npm run eval -- --live # the same against Sarvam for real, re-recording the cassettes (≈ ₹50)
```

Eval traces land in `eval/runs/<time>/`; open one with `eval/viewer/index.html`. The latest results are in `eval/report.md`, and status is in `docs/phase-1.md`.

In the panel:
- **Talk:** hold `Space` or `` ` ``, or type in the command bar (Kivi types there when you hold Fn).
- **Stop:** press `Esc`.

**Try saying:** "Chennai se Bengaluru kal ka sleeper ticket book karo", "இந்த பக்கத்தில் என்ன இருக்கு?" ("What's on this page?"), "complaint likhna hai" ("I want to write a complaint").

## Layout

npm workspaces. The core has no Node dependencies, so the browser extension can reuse it as-is.

```
packages/core/       platform-free agent: orchestrator, tools, prompts, safety gate, navigation policy,
                     phrases, voice-session state machine, page model (snapshot.js), interfaces
packages/providers/  Sarvam clients (stt, tts, llm, vision, translate, cost meter)
packages/ui/         React panel (mic worklet, PCM player, earcons)
apps/dev-harness/    Fastify + Playwright server for development, eval and CI (+ check/snapshot scripts)
fixtures/            Pathik Rail mock, bills, HTML fixtures for page-model tests
eval/                end-to-end agent eval on Pathik Rail
docs/spikes/         Phase 0 go/no-go notes
spikes/              throwaway spike code (extension, proxy)
```

Pathik Rail and all its data are fictional. No real bookings or payments are made.
