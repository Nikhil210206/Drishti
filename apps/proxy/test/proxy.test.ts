import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index.js";
import { mintToken, verifyToken } from "../src/token.js";
import { istDay } from "../src/quota.js";
import { sockets } from "../src/sockets.js";

const SECRET = "test-secret-0123456789abcdef0123456789";

/** D1 stand-in for the one upsert the quota runs: it adds only while the total stays within the limit. */
function fakeDb() {
  const rows = new Map<string, number>();
  const db = {
    rows,
    writes: 0,
    prepare: () => ({
      bind: (device: string, day: string, units: number, limit: number) => ({
        first: async () => {
          const k = `${device}|${day}`;
          const had = rows.get(k);
          if (had !== undefined && had + units > limit) return null; // DO UPDATE … WHERE: nothing written
          rows.set(k, (had ?? 0) + units);
          db.writes++;
          return { units: rows.get(k) };
        },
      }),
    }),
  };
  return db;
}

const limiter = (ok: boolean) => ({ limit: async () => ({ success: ok }) });

function env(over: Partial<Env> = {}): Env {
  return { SARVAM_API_KEY: "sk-real", TOKEN_SECRET: SECRET, TURNSTILE_SECRET: "ts", DB: fakeDb() as any, ...over };
}

function upstream(reply: Response | (() => Response) = new Response('{"ok":true}', { headers: { "content-type": "application/json" } })) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return typeof reply === "function" ? reply() : reply.clone();
    }),
  );
  return calls;
}

const chat = (token?: string, extra: Record<string, string> = {}) =>
  new Request("https://proxy.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
    body: JSON.stringify({ model: "sarvam-105b", messages: [] }),
  });

afterEach(() => vi.unstubAllGlobals());

describe("device tokens", () => {
  it("verify only with the secret they were signed with", async () => {
    const { token, device } = await mintToken(SECRET);
    expect((await verifyToken(SECRET, token))?.device).toBe(device);
    expect(await verifyToken("other", token)).toBeUndefined();
    const [payload, sig] = token.split(".");
    expect(await verifyToken(SECRET, `${payload}x.${sig}`)).toBeUndefined();
    expect(await verifyToken(SECRET, "garbage")).toBeUndefined();
  });

  it("expire after a year", async () => {
    const t0 = Date.UTC(2026, 9, 5);
    const { token } = await mintToken(SECRET, t0);
    expect(await verifyToken(SECRET, token, t0 + 364 * 86400e3)).toBeDefined();
    expect(await verifyToken(SECRET, token, t0 + 366 * 86400e3)).toBeUndefined();
  });

  it("are minted only after Turnstile says yes", async () => {
    upstream(new Response(JSON.stringify({ success: true })));
    const ok = await worker.fetch(
      new Request("https://proxy.test/v1/token", { method: "POST", body: JSON.stringify({ turnstile: "t" }) }),
      env(),
    );
    const { token } = (await ok.json()) as { token: string };
    expect(await verifyToken(SECRET, token)).toBeDefined();

    upstream(new Response(JSON.stringify({ success: false })));
    const no = await worker.fetch(
      new Request("https://proxy.test/v1/token", { method: "POST", body: JSON.stringify({ turnstile: "t" }) }),
      env(),
    );
    expect(no.status).toBe(403);
  });
});

describe("token minting from the website", () => {
  const preflight = (origin: string) =>
    worker.fetch(
      new Request("https://proxy.test/v1/token", { method: "OPTIONS", headers: { origin } }),
      env({ WEBSITE_ORIGINS: "https://drishti.example" }),
    );

  it("allows the website's own origin, and no other", async () => {
    const ok = await preflight("https://drishti.example");
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://drishti.example");
    const other = await preflight("https://evil.example");
    expect(other.status).toBe(403);
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("puts the CORS header on a minted token", async () => {
    upstream(new Response(JSON.stringify({ success: true })));
    const res = await worker.fetch(
      new Request("https://proxy.test/v1/token", {
        method: "POST",
        headers: { origin: "https://drishti.example" },
        body: JSON.stringify({ turnstile: "t" }),
      }),
      env({ WEBSITE_ORIGINS: "https://drishti.example" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://drishti.example");
  });
});

describe("proxy", () => {
  it("refuses everything until its secrets are set", async () => {
    const calls = upstream();
    const { token } = await mintToken(SECRET);
    for (const e of [env({ TOKEN_SECRET: "" }), env({ TOKEN_SECRET: "short" }), env({ SARVAM_API_KEY: "" })]) {
      const res = await worker.fetch(chat(token), e);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "not_configured" });
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses requests without a valid device token", async () => {
    upstream();
    expect((await worker.fetch(chat(), env())).status).toBe(401);
    expect((await worker.fetch(chat("forged.token"), env())).status).toBe(401);
  });

  it("forwards an allowed call with the key added, and nothing else of the caller's", async () => {
    const calls = upstream();
    const { token } = await mintToken(SECRET);
    const res = await worker.fetch(chat(token, { cookie: "session=abc", "x-forwarded-for": "1.2.3.4" }), env());
    expect(res.status).toBe(200);
    expect(calls[0].url).toBe("https://api.sarvam.ai/v1/chat/completions");
    const sent = calls[0].init.headers as Record<string, string>;
    expect(sent).toEqual({ "api-subscription-key": "sk-real", "content-type": "application/json" });
  });

  it("only knows the endpoints Drishti uses", async () => {
    upstream();
    const { token } = await mintToken(SECRET);
    const get = (p: string) => new Request(`https://proxy.test${p}`, { headers: { authorization: `Bearer ${token}` } });
    expect((await worker.fetch(get("/v1/models"), env())).status).toBe(404);
    expect((await worker.fetch(get("/text-to-speech"), env())).status).toBe(404);
    expect((await worker.fetch(get("/doc-ai/v1/job/abc-123/status"), env())).status).toBe(200);
    expect((await worker.fetch(get("/doc-ai/v1/job/../../admin/status"), env())).status).toBe(404);
    expect((await worker.fetch(get("/v1/chat/completions"), env())).status).toBe(405);
  });

  it("wants a WebSocket on the speech routes", async () => {
    const { token } = await mintToken(SECRET);
    const res = await worker.fetch(
      new Request("https://proxy.test/speech-to-text-realtime/ws", { headers: { "sec-websocket-protocol": `drishti, ${token}` } }),
      env(),
    );
    expect(res.status).toBe(426);
  });

  it("stops a device at its daily quota", async () => {
    upstream();
    const { token } = await mintToken(SECRET);
    const e = env({ DAILY_UNITS: "2" });
    expect((await worker.fetch(chat(token), e)).status).toBe(200);
    expect((await worker.fetch(chat(token), e)).status).toBe(200);
    const third = await worker.fetch(chat(token), e);
    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({ error: "quota" });
  });

  it("writes nothing for a device that keeps asking past its quota", async () => {
    upstream();
    const { token } = await mintToken(SECRET);
    const db = fakeDb();
    const e = env({ DAILY_UNITS: "2", DB: db as any });
    for (let i = 0; i < 10; i++) await worker.fetch(chat(token), e);
    expect(db.writes).toBe(2);
    expect([...db.rows.values()]).toEqual([2]);
  });

  it("refuses a speech socket by closing it with a code and reason the browser can read", async () => {
    // Node can't make a 101 response or a WebSocketPair: stand-ins that record the close.
    const closed: [number, string][] = [];
    vi.stubGlobal(
      "WebSocketPair",
      class {
        0 = {};
        1 = { accept() {}, close: (code: number, reason: string) => void closed.push([code, reason]) };
      },
    );
    const upgrade = vi.spyOn(sockets, "upgrade").mockImplementation(() => new Response(null, { status: 204 }));
    const calls = upstream();
    const socket = (token: string) =>
      new Request("https://proxy.test/speech-to-text-realtime/ws", {
        headers: { upgrade: "websocket", "sec-websocket-protocol": `drishti, ${token}` },
      });

    await worker.fetch(socket("forged.token"), env());
    const { token } = await mintToken(SECRET);
    await worker.fetch(socket(token), env({ DAILY_UNITS: "1" })); // a speech socket costs 2 units
    await worker.fetch(socket(token), env({ DEVICE_LIMIT: limiter(false) as any }));
    expect(closed).toEqual([
      [4401, "unauthorized"],
      [4429, "quota"],
      [4429, "slow_down"],
    ]);
    expect(upgrade).toHaveBeenCalledTimes(3);
    expect(calls).toHaveLength(0); // nothing reached Sarvam
  });

  it("says busy when every user together is at Sarvam's limit", async () => {
    upstream();
    const { token } = await mintToken(SECRET);
    const res = await worker.fetch(chat(token), env({ GLOBAL_LLM: limiter(false) as any }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "busy" });
    expect(res.headers.get("retry-after")).toBe("5");
  });

  it("refuses oversized bodies before they go anywhere", async () => {
    const calls = upstream();
    const { token } = await mintToken(SECRET);
    const res = await worker.fetch(chat(token, { "content-length": String(300 * 1024) }), env());
    expect(res.status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it("counts the day in India time", () => {
    expect(istDay(Date.UTC(2026, 9, 5, 18, 29))).toBe("2026-10-05");
    expect(istDay(Date.UTC(2026, 9, 5, 18, 31))).toBe("2026-10-06");
  });
});
