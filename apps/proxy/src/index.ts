/**
 * Drishti proxy (Cloudflare Worker, free plan).
 *
 * The extension talks to Sarvam through here so the API key never ships inside it. The proxy
 * answers at the same paths as api.sarvam.ai, for exactly the endpoints Drishti uses, so a provider
 * only swaps its base URL and credential:
 *
 *   POST /v1/token                          Turnstile response → device token
 *   POST /v1/chat/completions               LLM (sarvam-105b)
 *   POST /translate                         Mayura / Sarvam-Translate
 *   POST /doc-ai/v1/job/digitise            Doc AI job (multipart upload)
 *   GET  /doc-ai/v1/job/:id/status          … its status
 *   GET  /doc-ai/v1/job/:id/download-url    … where to fetch the result
 *   WS   /speech-to-text-realtime/ws        Saaras realtime STT
 *   WS   /text-to-speech/ws                 Bulbul streaming TTS
 *
 * REST calls carry `Authorization: Bearer <device token>`. Browsers can't set headers on a
 * WebSocket, so sockets carry it as a subprotocol (`drishti`, `<token>`), never in the URL where
 * request logs would keep it.
 *
 * Privacy: nothing here logs, stores or inspects request or response bodies. Messages on the
 * sockets are forwarded unchanged (spike 2: that is also what keeps a relay under 10 ms CPU).
 */
import { mintToken, verifyToken } from "./token.js";
import { spend, type Kind } from "./quota.js";
import { refuseSocket, sockets } from "./sockets.js";

export interface Env {
  SARVAM_API_KEY: string;
  TOKEN_SECRET: string;
  TURNSTILE_SECRET: string;
  DB: D1Database;
  /** Sarvam's shared limit (40 LLM calls a minute on the starter plan), for every device together. */
  GLOBAL_LLM?: RateLimit;
  /** Bursts from one device. */
  DEVICE_LIMIT?: RateLimit;
  /** Token minting, per IP. */
  MINT_LIMIT?: RateLimit;
  DAILY_UNITS?: string;
  /** Origins of the website whose connect page may mint tokens (comma-separated). */
  WEBSITE_ORIGINS?: string;
  SARVAM_BASE?: string;
}

interface Route {
  kind: Kind;
  method: "GET" | "POST";
  ws?: boolean;
  maxBytes?: number;
}

const KB = 1024;
const ROUTES: [RegExp, Route][] = [
  [/^\/v1\/chat\/completions$/, { kind: "chat", method: "POST", maxBytes: 256 * KB }],
  [/^\/translate$/, { kind: "translate", method: "POST", maxBytes: 64 * KB }],
  [/^\/doc-ai\/v1\/job\/digitise$/, { kind: "docJob", method: "POST", maxBytes: 10 * KB * KB }],
  [/^\/doc-ai\/v1\/job\/[\w-]{1,80}\/(status|download-url)$/, { kind: "docPoll", method: "GET" }],
  [/^\/speech-to-text-realtime\/ws$/, { kind: "stt", method: "GET", ws: true }],
  [/^\/text-to-speech\/ws$/, { kind: "tts", method: "GET", ws: true }],
];

/** A speech socket is closed after this long; the client reconnects (it already does on drops). */
const MAX_SOCKET_MS = 15 * 60 * 1000;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname === "/v1/token") {
      const cors = corsFor(req, env);
      if (req.method === "OPTIONS") return new Response(null, { status: cors ? 204 : 403, headers: cors });
      if (req.method === "POST") {
        const res = await mint(req, env);
        for (const [k, v] of Object.entries(cors ?? {})) res.headers.set(k, v);
        return res;
      }
    }

    const route = ROUTES.find(([re]) => re.test(url.pathname))?.[1];
    if (!route) return json(404, { error: "not_found" });
    if (req.method !== route.method) return json(405, { error: "method_not_allowed" });

    const ws = route.ws ? req.headers.get("Upgrade")?.toLowerCase() === "websocket" : false;
    if (route.ws && !ws) return json(426, { error: "expected_websocket" });
    // A browser never learns why a socket's handshake failed, so a speech socket is refused by
    // accepting it and closing it at once with 4000 + the status, and the error as the reason.
    const refuse = (status: number, error: string, retryAfter: string) =>
      ws ? refuseSocket(4000 + status, error) : json(status, { error }, retryAfter ? { "retry-after": retryAfter } : {});
    const token = ws ? subprotocolToken(req) : bearer(req);
    const id = await verifyToken(env.TOKEN_SECRET, token);
    if (!id) return refuse(401, "unauthorized", "");

    const size = Number(req.headers.get("content-length") ?? 0);
    if (route.maxBytes && size > route.maxBytes) return json(413, { error: "too_large" });

    if (env.DEVICE_LIMIT && !(await env.DEVICE_LIMIT.limit({ key: id.device })).success) return refuse(429, "slow_down", "10");
    if (route.kind === "chat" && env.GLOBAL_LLM && !(await env.GLOBAL_LLM.limit({ key: "global" })).success)
      return refuse(429, "busy", "5");
    if (!(await spend(env.DB, id.device, route.kind, Number(env.DAILY_UNITS ?? 400)))) return refuse(429, "quota", "3600");

    const upstream = `${env.SARVAM_BASE ?? "https://api.sarvam.ai"}${url.pathname}${url.search}`;
    return ws ? relaySocket(upstream, env) : forward(req, upstream, env);
  },
};

/** CORS for the website's connect page, and only for it. */
function corsFor(req: Request, env: Env): Record<string, string> | undefined {
  const origin = req.headers.get("origin");
  const allowed = (env.WEBSITE_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  if (!origin || !allowed.includes(origin)) return undefined;
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST",
    "access-control-allow-headers": "content-type",
    vary: "origin",
  };
}

function bearer(req: Request) {
  const m = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i);
  return m?.[1];
}

/** `new WebSocket(url, ["drishti", token])` sends "drishti, <token>". */
function subprotocolToken(req: Request) {
  const parts = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((s) => s.trim());
  return parts[0] === "drishti" ? parts[1] : undefined;
}

async function mint(req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get("cf-connecting-ip") ?? "";
  if (env.MINT_LIMIT && !(await env.MINT_LIMIT.limit({ key: ip || "unknown" })).success)
    return json(429, { error: "slow_down" }, { "retry-after": "60" });
  let response = "";
  try {
    response = String(((await req.json()) as { turnstile?: unknown }).turnstile ?? "");
  } catch {}
  if (!response) return json(400, { error: "turnstile_missing" });
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", response);
  if (ip) form.append("remoteip", ip);
  const check = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const outcome = (await check.json().catch(() => ({}))) as { success?: boolean };
  if (!outcome.success) return json(403, { error: "turnstile_failed" });
  const { token } = await mintToken(env.TOKEN_SECRET);
  return json(200, { token });
}

/** Forward a REST call with the key added; only the content type goes up and comes back. */
async function forward(req: Request, upstream: string, env: Env): Promise<Response> {
  const headers: Record<string, string> = { "api-subscription-key": env.SARVAM_API_KEY };
  const type = req.headers.get("content-type");
  if (type) headers["content-type"] = type;
  const res = await fetch(upstream, { method: req.method, headers, body: req.method === "GET" ? undefined : req.body });
  return new Response(res.body, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json", "cache-control": "no-store" },
  });
}

/** Relay a speech socket to Sarvam, adding the key; messages pass through unchanged. */
async function relaySocket(upstreamUrl: string, env: Env): Promise<Response> {
  const up = await fetch(upstreamUrl.replace(/^ws/, "http"), {
    headers: { Upgrade: "websocket", "api-subscription-key": env.SARVAM_API_KEY },
  });
  const upstream = up.webSocket;
  if (!upstream) return json(502, { error: "upstream_refused", status: up.status });
  upstream.accept();

  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.accept();

  let open = true;
  const closeBoth = (code = 1000, reason = "") => {
    if (!open) return;
    open = false;
    clearTimeout(timer);
    try {
      upstream.close(code, reason);
    } catch {}
    try {
      server.close(code, reason);
    } catch {}
  };
  const timer = setTimeout(() => closeBoth(1000, "session time limit"), MAX_SOCKET_MS);
  server.addEventListener("message", (e) => open && upstream.send(e.data));
  upstream.addEventListener("message", (e) => open && server.send(e.data));
  server.addEventListener("close", (e) => closeBoth(e.code === 1005 ? 1000 : e.code, e.reason));
  upstream.addEventListener("close", (e) => closeBoth(e.code === 1005 ? 1000 : e.code, e.reason));
  server.addEventListener("error", () => closeBoth(1011, "client error"));
  upstream.addEventListener("error", () => closeBoth(1011, "upstream error"));

  return sockets.upgrade(client);
}
