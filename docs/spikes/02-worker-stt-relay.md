# Spike 2: Cloudflare Worker relay to Saaras realtime STT

**Decision: GO. Use a stateless Worker relay on the free plan.**

- It was deployed and tested on 2026-10-03.
- It adds about 25 ms to the final transcript.
- A continuous 5-minute session (about 6,000 relayed messages) was not cut off by the free plan's 10 ms CPU limit.
- The Durable Object variant stays as a contingency only.
- REST STT plus client VAD remains the BYOK path and the fallback.

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

## Deployed test (2026-10-03, your Cloudflare account, free plan)

Worker: `drishti-relay-spike.nikhil-drishti.workers.dev`, secrets set with `wrangler secret put`. The client ran from your Mac.

| Path | Connect | Final transcript after speech ends | Transcript |
|---|---|---|---|
| Direct to Saaras | 437 ms | **966 ms** | correct, `ta-IN` |
| Through the deployed relay | 523 ms | **991 ms** | identical |
| Relay with a wrong device token | – | rejected, HTTP 403 | – |
| REST, whole clip | – | **447 ms** request | identical |

**Soak tests**: one relay session, the 4.6 s clip plus 1.5 s of silence on a loop (the hands-free worst case):

| Session | Stayed connected | Audio chunks sent | Transcripts back | Result |
|---|---|---|---|---|
| 60 s | 62 s | 610 | 10 | ✅ |
| 5 min | 303 s | 2,989 | 49 | ✅ |

A 5-minute session relays about 3,000 messages each way with no CPU kill. In practice, the free plan's 10 ms limit does not bite a pure relay that forwards each message unchanged.

The `wrangler tail` outcomes and the dashboard's CPU-time metrics were not recorded. Check them once the real proxy is deployed in Phase 2, since a later Cloudflare change could tighten enforcement.

## Recommendation

- Phase 2 relay: a **stateless Worker** (proven above). Keep the Durable Object variant as a contingency if Cloudflare starts enforcing CPU per WebSocket session. Per-utterance REST STT is the fallback mode, which is also the BYOK path.
- Keep the relay pure: forward messages unchanged, with no transcoding, logging or per-message parsing in the Worker. That is what keeps it under the CPU limit, and it also matches the privacy rule.
- REST has no partial transcripts. The panel's live caption is nice but not essential for blind users, since speech output matters more than captions.
- Relay quota counting: 100k requests/day counts WebSocket *connections*, not messages, so one session is one request.
