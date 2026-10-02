# Spike 2: Cloudflare Worker relay to Saaras realtime STT

**Decision: GO on the relay design, with a CPU-limit risk that only a deployed test settles.**

- The relay works and adds about 70 ms.
- REST STT plus client VAD is a viable plan B with near-equal latency.
- If the free-plan CPU limit bites on long WebSocket sessions, move the relay into a SQLite-backed Durable Object (free plan). Durable Objects reset CPU time per WebSocket message.

- Code: `spikes/proxy/src/index.ts` (Worker) and `spikes/proxy/client.ts` (comparison client).
- Run locally with `npx wrangler@4 dev --port 8788` in `spikes/proxy` (key in a gitignored `.dev.vars`), then `npx tsx spikes/proxy/client.ts`.
- Date: 2026-10-02, wrangler 4.147, local workerd. Same 4.6 s Tamil clip for every path (`cache/spike-ta.wav`).

## Results

| Path | Connect | Final transcript after speech ends | Transcript |
|---|---|---|---|
| Direct to Saaras WS (Node, key in header) | 392 ms | **981 ms** | correct, `ta-IN` |
| Through the Worker relay (local) | 121 ms to Worker | **1,051 ms** | identical |
| Relay with a wrong device token | – | rejected, HTTP 403 | – |
| REST `/speech-to-text`, whole clip after the user stops | – | **452 ms** request (plus client VAD silence wait, about 500–700 ms) | identical |

**Saaras rejects the key in a query parameter** (`invalid_subscription_key`), and browsers cannot set headers on a WebSocket. So a browser can **never** stream to Saaras directly, even with a user's own key (BYOK). Realtime needs our relay. BYOK users can use REST from the extension's service worker, where `fetch` can set the header.

## Free-plan limits (Cloudflare docs, checked 2026-10-02)

- Workers Free: **10 ms CPU per request**, 100,000 requests/day, no duration limit while the client stays connected, 6 simultaneous outgoing connections, 32 MiB WebSocket messages.
- The docs do not say how CPU is counted for a long-lived WebSocket in a stateless Worker.
- **Durable Objects are on the free plan (SQLite-backed only)**, and "each incoming HTTP request or WebSocket message resets the remaining available CPU time".

The relay does almost no work per message: it forwards about 4.3 KB of JSON every 100 ms. Local workerd does not enforce or report production CPU time, so the 10 ms question is **not answered locally**.

## What would settle it (needs your Cloudflare account)

1. `npx wrangler login` (free account), then `npx wrangler secret put SARVAM_API_KEY` and `DEVICE_TOKEN`.
2. Run `npx wrangler deploy`. Point `RELAY=wss://drishti-relay-spike.<you>.workers.dev npx tsx spikes/proxy/client.ts` at it and stream a 60 s and a 5 min session.
3. If sessions die with "exceeded CPU" (error 1102), switch to a Durable Object relay with the same code inside a DO class, or to REST STT.

I did not deploy, because that uses your account.

## Recommendation

- Phase 2 relay: a stateless Worker first (simplest), with the DO variant ready. Per-utterance REST STT is the fallback mode, which is also the BYOK path.
- REST has no partial transcripts. The panel's live caption is nice but not essential for blind users, since speech output matters more than captions.
- Relay quota counting: 100k requests/day counts WebSocket *connections*, not messages, so one session is one request.
