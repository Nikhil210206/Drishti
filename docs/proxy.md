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
| `POST /v1/chat/completions` | LLM; also capped at 40 a minute for all users together ("busy" above that), counted per Cloudflare location | 1 |
| `POST /translate` | Mayura / Sarvam-Translate | 1 |
| `POST /doc-ai/v1/job/digitise` | Doc AI job (up to 10 MB) | 10 |
| `GET /doc-ai/v1/job/:id/status`, `/download-url` | Doc AI polling | 0 |
| `WS /speech-to-text-realtime/ws` | Saaras realtime STT (closed after 15 min; the client reconnects when the user next talks) | 2 |
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

**Sockets** can't show a browser an HTTP status: a failed handshake only says "closed". So a refused speech socket is accepted and closed at once with `4000 + status` and the error as the reason: `4401 unauthorized`, `4429 slow_down` or `4429 quota`.

**What the user hears:** the panel says what each refusal means. `busy` and `slow_down`: try again in a minute. `quota`: today's limit is used, back tomorrow. `unauthorized`: set up Drishti again. If Bulbul is refused as well (it shares the quota), the panel reads the reply in the browser's own voice.

**The LLM cap is per location.** Cloudflare counts rate limits per data centre, so with users in several cities the real total can pass 40 a minute. Sarvam then answers 429 itself, and the LLM client retries with backoff.

**Why D1, not KV, for the quota:** KV's free plan allows 1,000 writes a day, which one write per request would use up with a handful of users. D1 allows 100,000, the same as the Workers request cap. A refused request writes nothing, so a device at its limit can't use them up by retrying.

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

On 2026-10-08 the forged socket check became "closed with `4401 unauthorized`", since refused sockets now close with a reason.

## Deploy (your Cloudflare account)

**Deployed on 2026-10-08:**

| Piece | Where |
|---|---|
| Proxy | `https://drishti-proxy.nikhil-drishti.workers.dev` |
| Quota database | D1 `drishti-quota`, APAC |
| Website | `https://drishti-voice.pages.dev`: connect, privacy, and `practice/` (Pathik Rail) |
| Turnstile | widget `drishti-connect`, managed mode, site key `0x4AAAAAAFRdfJ8F1p9vk7bZ` (public) |

**Never deploy with the test Turnstile secret:** anyone could mint tokens and spend your credits. The proxy answers `503 not_configured` until `SARVAM_API_KEY` and a `TOKEN_SECRET` of 32+ characters are set.

### Steps, as done (run in `apps/proxy` unless noted)

1. Create the database and apply the schema:
   - `npx wrangler d1 create drishti-quota`, then put the printed `database_id` in `wrangler.toml`.
   - `npx wrangler d1 execute drishti-quota --remote --file=schema.sql`
   - Run the same with `--local`: a new id means a new local database.
2. `wrangler.toml`: `WEBSITE_ORIGINS` is the deployed website, the only origin that gets CORS for minting. `.dev.vars` sets `WEBSITE_ORIGINS=http://localhost:5175` for local development.
3. Deploy the Worker: `npx wrangler deploy`.
4. Create the Turnstile widget:

   ```bash
   npx wrangler turnstile widget create drishti-connect --domain <project>.pages.dev --mode managed
   ```

   The site key is public: it goes into the website build. The secret goes only to the Worker (next step).
5. Set the three secrets. Each command pipes its value, so it never shows on screen:

   ```bash
   grep '^SARVAM_API_KEY=' .dev.vars | cut -d= -f2- | tr -d '"\n' | npx wrangler secret put SARVAM_API_KEY
   openssl rand -hex 32 | tr -d '\n' | tee .token-secret | npx wrangler secret put TOKEN_SECRET
   npx wrangler turnstile widget get <site key> --json | python3 -c "import json,sys; print(json.load(sys.stdin)['secret'], end='')" | npx wrangler secret put TURNSTILE_SECRET
   ```

   - **Strip the quotes:** `.dev.vars` keeps the Sarvam key in quotes. `wrangler dev` removes them, but a pipe doesn't, and a quoted key fails at Sarvam with "Invalid or missing authentication credentials".
   - **`.token-secret`** (gitignored) lets `scripts/mint.ts` mint test tokens for the deployed proxy.
6. The website (from the repo root): `npm run deploy -w @drishti/website`.
   - This builds `dist/` with the proxy address and site key (`scripts/build.ts` refuses the test key for a deployed proxy) and uploads it to Pages.
   - The project was created once with `npx wrangler pages project create <project> --production-branch main --force`. This wrangler sends Pages commands to Cloudflare's newer Workers hosting, which failed and deployed nothing; `--force` makes a classic Pages project, at `<project>.pages.dev`.
   - Pages drops `.html` (`/connect.html` → 308 → `/connect`) and keeps the query string, so the connect link still works.
7. The extension: `npm run build:release -w @drishti/extension` builds `.output/chrome-mv3-release` from `apps/extension/.env.release` (`WXT_PROXY`, `WXT_WEBSITE`).
   - The proxy and the website go into the manifest's host permissions: requests to the proxy skip CORS, and the practice site needs no question.
   - Only that website may hand the extension a token (`externally_connectable`).
   - A release build has no localhost access.
   - A plain `npm run build` stays local (`localhost:8788`, `localhost:5175`, practice at `localhost:5174`).
8. Check it:

   ```bash
   TOKEN=$(npx tsx apps/proxy/scripts/mint.ts) npx tsx apps/proxy/scripts/smoke.ts https://drishti-proxy.nikhil-drishti.workers.dev cache/spike-ta.wav
   ```

   Treat a minted token like a password: it spends your credits until you rotate `TOKEN_SECRET`.

Rotating `TOKEN_SECRET` revokes every token. Devices then mint new ones through Turnstile.

Check the CPU-time metric in the dashboard after a few real sessions (spike 2 left this open), in case Cloudflare starts enforcing the 10 ms limit on long sockets. The Durable Object relay is the contingency.
