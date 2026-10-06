# Drishti proxy: setup and deploy

`apps/proxy` is a Cloudflare Worker on the free plan. It holds the Sarvam key, so the extension never ships it. It also:

- mints device tokens after a Turnstile check;
- enforces a per-device daily quota and Sarvam's shared rate limit;
- relays requests to Sarvam.

It stores no page content, audio or transcripts and logs nothing.

## What it serves

| Path | What | Quota units |
|---|---|---|
| `POST /v1/token` | Turnstile response → device token (5 a minute per IP) | – |
| `POST /v1/chat/completions` | LLM; also capped at 40 a minute for all users together ("busy" above that) | 1 |
| `POST /translate` | Mayura / Sarvam-Translate | 1 |
| `POST /doc-ai/v1/job/digitise` | Doc AI job (up to 10 MB) | 10 |
| `GET /doc-ai/v1/job/:id/status`, `/download-url` | Doc AI polling | 0 |
| `WS /speech-to-text-realtime/ws` | Saaras realtime STT (closed after 15 min; the client reconnects) | 2 |
| `WS /text-to-speech/ws` | Bulbul streaming TTS | 1 |

The paths are Sarvam's own, so a provider only swaps its base URL and credential. Anything else is a 404.

**Credentials:**

- REST calls send `Authorization: Bearer <token>`.
- Sockets send the token as a subprotocol: `new WebSocket(url, ["drishti", token])`. Browsers can't set WebSocket headers, and a token in the URL would end up in request logs. The proxy accepts only `drishti`, so the token is never echoed back.

**Errors:** all are JSON `{ "error": … }`.

| Status | Error |
|---|---|
| 401 | `unauthorized` |
| 404 | `not_found` |
| 413 | `too_large` |
| 426 | `expected_websocket` |
| 429 | `busy` (retry after 5 s); `slow_down` (one device bursting); `quota` (daily limit, 400 units ≈ 40 tasks) |

The panel speaks a "busy" or "limit reached" phrase for these.

**Why D1, not KV, for the quota:** KV's free plan allows 1,000 writes a day, which one write per request would use up with a handful of users. D1 allows 100,000, the same as the Workers request cap.

## Local

```bash
cd apps/proxy
npx wrangler d1 execute drishti-quota --local --file=schema.sql
```

`.dev.vars` (gitignored) holds `SARVAM_API_KEY`, `TOKEN_SECRET` and the always-pass Turnstile **test** secret `1x0000000000000000000000000000000AA`. Start it with `npm run dev -w @drishti/proxy -- --port 8788`, then:

```bash
npx tsx apps/proxy/scripts/smoke.ts http://localhost:8788 cache/spike-ta.wav
```

Result on 2026-10-05:

| Check | Result |
|---|---|
| Mint a token | ✅ |
| Refuse a request without a token | ✅ |
| Translate | ✅ 0.9 s |
| Chat | ✅ 0.15 s |
| TTS over the relay | ✅ first audio at 0.34 s |
| STT over the relay (Tamil) | ✅ final transcript 1.2 s after the audio ended, including the VAD pause |
| Refuse a forged socket token | ✅ |

## Deploy (your Cloudflare account)

**Never deploy with the test Turnstile secret:** anyone could mint tokens and spend your credits.

1. `cd apps/proxy`
2. `npx wrangler d1 create drishti-quota`, then paste the printed `database_id` into `wrangler.toml`.
3. `npx wrangler d1 execute drishti-quota --remote --file=schema.sql`
4. Set the secrets:
   - `npx wrangler secret put SARVAM_API_KEY`
   - `npx wrangler secret put TOKEN_SECRET`: a long random string, e.g. from `openssl rand -hex 32`.
   - `npx wrangler secret put TURNSTILE_SECRET`: the secret of the Turnstile widget for the website, once it exists. Until then, use any random string; minting is then impossible, and you mint test tokens by hand (next step).
5. `npx wrangler deploy`
6. To test before the website exists:
   - `TOKEN_SECRET=… npx tsx apps/proxy/scripts/mint.ts` prints a token.
   - Treat it like a password: it spends your credits until you rotate `TOKEN_SECRET`.

Rotating `TOKEN_SECRET` revokes every token. Devices then mint new ones through Turnstile.

Check the CPU-time metric in the dashboard after a few real sessions (spike 2 left this open), in case Cloudflare starts enforcing the 10 ms limit on long sockets. The Durable Object relay is the contingency.
