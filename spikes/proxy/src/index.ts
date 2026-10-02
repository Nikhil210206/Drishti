/**
 * Spike 2: relay a panel's WebSocket to Saaras realtime STT, adding the Sarvam key server-side.
 * The client never sees the key; the Worker never logs or stores audio or transcripts.
 */
interface Env {
  SARVAM_API_KEY: string;
  DEVICE_TOKEN: string;
}

const SARVAM_STT_WS = "https://api.sarvam.ai/speech-to-text-realtime/ws";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname !== "/stt") return new Response("not found", { status: 404 });
    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected a websocket", { status: 426 });
    // Spike stand-in for the real device token (Turnstile-minted, per-device quota in KV).
    if (url.searchParams.get("token") !== env.DEVICE_TOKEN) return new Response("forbidden", { status: 403 });
    url.searchParams.delete("token");

    const up = await fetch(`${SARVAM_STT_WS}?${url.searchParams}`, {
      headers: { Upgrade: "websocket", "api-subscription-key": env.SARVAM_API_KEY },
    });
    const upstream = up.webSocket;
    if (!upstream) return new Response(`upstream refused: HTTP ${up.status}`, { status: 502 });
    upstream.accept();

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();

    let fromClient = 0;
    let fromUpstream = 0;
    server.addEventListener("message", (e) => {
      fromClient++;
      upstream.send(e.data);
    });
    upstream.addEventListener("message", (e) => {
      fromUpstream++;
      // Relay stats ride along on session end so the spike client can report them.
      server.send(e.data);
    });
    const closeBoth = (code = 1000, reason = "") => {
      try {
        server.send(JSON.stringify({ event: "relay.stats", fromClient, fromUpstream }));
      } catch {}
      try {
        upstream.close(code, reason);
      } catch {}
      try {
        server.close(code, reason);
      } catch {}
    };
    server.addEventListener("close", (e) => closeBoth(e.code === 1005 ? 1000 : e.code, e.reason));
    upstream.addEventListener("close", (e) => closeBoth(e.code === 1005 ? 1000 : e.code, e.reason));
    server.addEventListener("error", () => closeBoth(1011, "client error"));
    upstream.addEventListener("error", () => closeBoth(1011, "upstream error"));

    return new Response(null, { status: 101, webSocket: client });
  },
};
