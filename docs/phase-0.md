# Phase 0 status (W1–2, 5–18 Oct 2026)

Started 2026-10-02, ahead of W1. The roadmap is in `~/.claude/plans/now-since-the-event-twinkly-pizza.md`.

## Day 1

- [ ] Apply to the Sarvam Startup Program and ask for higher rate limits. **You:** a draft is in `docs/sarvam-startup-application.md`.

## Restructure ✅

- [x] npm workspaces: `packages/core`, `packages/providers`, `packages/ui`, `apps/dev-harness`, `fixtures/`, `eval/`.
- [x] Core behind interfaces in `packages/core/src/types.ts`: `BrowserDriver`, `LLM`, `Translator`, `DocReader`, `Cache`, `SpeechIn`, `SpeechOut`.
  - Core typechecks with **no Node types**, so the extension can use it as-is.
- [x] Session state machine split out of the WebSocket server (`packages/core/src/session.ts`).
- [x] `snapshot.js` exported as a function (`snapshotPage`). The same file runs through Playwright and `chrome.scripting` (spike 3).
- [x] The harness still passes today's flows:
  - The Pathik Rail page-model walk (`npm run snapshot`).
  - The panel connects to the server, Saaras and the browser (`npm run dev`).
  - A live 105B task ran end to end (`npm run eval -- search-en-list`).

## Security fixes ✅

- [x] Removed "host label said in conversation" from the allowlist. Domains are anchored (`evilwikipedia.org` and `wikipedia.org.evil.com` are blocked). See `packages/core/src/agent/policy.ts`.
- [x] One navigation policy for the `navigate` tool, clicked links (checked before the click), the panel's `home{url}`, and anything else that lands on a disallowed site (redirects, new tabs). The agent goes back and reports the block.
- [x] Irreversible words anywhere in a label beat the SAFE list ("Show & pay" needs a yes). Generic "Next/Continue/OK" on a page asking for money needs a yes too.
- [x] TTS caches only fixed phrases (`speak(..., { cache: true })`), in a new `cache/tts-phrases/` dir.
  - **You:** delete the old `cache/tts/`. It may hold spoken PNRs from demos.
  - Sarvam Vision results are now in memory only. **You:** delete `cache/vision/`.
- [x] PDF prefetch removed. Documents go to Vision only when `read_document` is called.
- [x] Hardcoded profile deleted. An optional profile comes from `PROFILE_*` in `.env`. The eval uses a fictional test passenger.
- [x] Spike 5 found that "yes, but first…" counted as yes. Fixed: hedged yeses are now *unclear* in all 11 languages.

## Engineering baseline ✅

- [x] Lint: **oxlint** in place of ESLint. typescript-eslint supports TS < 6.1, and this repo is on TypeScript 7, the Go port.
- [x] Prettier (TS/JS/JSON/YAML; CSS, HTML and Markdown left hand-formatted). Strict TypeScript in every workspace.
- [x] Vitest, 139 tests:
  - safety (`needsConfirmation`, sensitive fields, yes/no in 11 languages, quick commands);
  - navigation policy;
  - agent gate and policy with a fake browser and scripted LLM;
  - session;
  - phrases;
  - tool-call recovery;
  - TTS cache;
  - page model in headless Chromium on HTML fixtures.
- [x] GitHub Actions (`.github/workflows/ci.yml`): lint, format, typecheck, tests, panel build.
- [x] LICENSE (Apache-2.0), with the `license` field in every package.json.

## Spikes

| # | Spike | Decision |
|---|---|---|
| 1 | Mic in the MV3 side panel | GO with the extension-tab fallback. **You:** a 3-minute manual check in real Chrome (`docs/spikes/01-side-panel-mic.md`). |
| 2 | Worker relay to Saaras WS vs REST + VAD | GO. The relay adds about 70 ms. The CPU limit needs a deployed test on your Cloudflare account (`docs/spikes/02-worker-stt-relay.md`). |
| 3 | `chrome.scripting` snapshot on real sites | GO. Six page-model bugs fixed (`docs/spikes/03-scripting-snapshot.md`). |
| 4 | Synthetic vs `chrome.debugger` input | Debugger by default on real sites (`docs/spikes/04-synthetic-vs-debugger-input.md`). |
| 5 | Base Laya on 50 yes/no replies | NO-GO for the base model (62%, 9 unsafe yes, versus 94% and 0 unsafe for the keyword gate). The fine-tuning track continues (`docs/spikes/05-laya-baseline.md`). |

## Exit criteria

- [x] Harness works after the move.
- [ ] CI green on GitHub. It passes locally (`npm run ci`); it runs on your next push.
- [ ] All 5 spikes decided. Spikes 1 and 2 each have one step that needs you (above).

## Noticed, not fixed (Phase 1)

- In the live smoke task, the 105B's second reply came back empty and Drishti said "I'm stuck", but `search-en-list` still "passed". That task has no real expectation, so the eval needs real checks for search tasks.
- The 220-element cap is spent on navigation before forms on big pages.
- The `yesNo` keyword lists need a native-speaker review per language.
