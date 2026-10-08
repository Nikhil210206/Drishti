/** Answers to a speech socket's upgrade. An object, so tests (Node can't build a 101 response) can stand in for it. */
export const sockets = {
  /** The 101 answer. The browser offered "drishti, <token>": accept the first, so the token is never echoed back. */
  upgrade: (client: WebSocket) => new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": "drishti" } }),
};

/** Accept a speech socket only to close it straight away with a code and reason the browser can read. */
export function refuseSocket(code: number, reason: string): Response {
  const pair = new WebSocketPair();
  pair[1].accept();
  pair[1].close(code, reason);
  return sockets.upgrade(pair[0]);
}
