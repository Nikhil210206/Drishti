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

- **Page model** (`server/browser/snapshot.js`) — turns any page into a numbered outline of about 300–900 tokens. It **infers names for unlabelled controls** from icon classes and nearby visual labels, names **colour-only indicators** such as `(colour: green)`, collapses repeated cards into single rows, and detects unmarked modal overlays.
- **Deterministic safety gate** (`server/agent/safety.ts`) — the model cannot skip it:
  - Pay, submit, send and delete always need a spoken yes in any of the 11 languages.
  - Drishti never types passwords, OTPs, card numbers or Aadhaar numbers.
  - It never attempts a CAPTCHA.
  - Page content is treated as untrusted, which defends against prompt injection.
  - Navigation is restricted to an allowlist of sites.
- **Voice UX** — push-to-talk or hands-free, interrupting Drishti mid-speech, earcons for every state, narration spoken while each action runs, and a latency HUD.
- **Pathik Rail** (`mock-sites/pathik-rail`) — a fictional train-booking site that is inaccessible on purpose. Add `?a11y=good` for the accessible version.

## Run it

```bash
npm install
npx playwright install chromium
cp .env.example .env   # add SARVAM_API_KEY
npm run check          # smoke-test every Sarvam API (TTS → STT loopback, 105B tool call, translate)
npm run dev            # panel http://localhost:5173 · agent browser opens on the right
```

In the panel:
- **Talk:** hold `Space` or `` ` ``, or type in the command bar (Kivi types there when you hold Fn).
- **Stop:** press `Esc`.

**Try saying:** "Chennai se Bengaluru kal ka sleeper ticket book karo", "இந்த பக்கத்தில் என்ன இருக்கு?" ("What's on this page?"), "complaint likhna hai" ("I want to write a complaint").

## Layout

```
server/            Node + Fastify + ws
  sarvam/          stt, tts, llm, vision, translate, cost meter
  agent/           orchestrator loop, tools, prompts, safety, phrases
  browser/         Playwright controller + injected page model
web/               React panel (mic worklet, PCM player, earcons)
mock-sites/        Pathik Rail mock + in-memory API
spikes/            API check + page-model dump
```

Pathik Rail and all its data are fictional. No real bookings or payments are made.
