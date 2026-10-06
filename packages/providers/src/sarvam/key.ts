/**
 * How a Sarvam client reaches Sarvam. Two ways, chosen per client:
 *
 * - `apiKey`: straight to api.sarvam.ai with the key (dev harness, eval, bring-your-own-key).
 * - `token` + `baseUrl`: through the Drishti proxy with a device token (the extension). The proxy
 *   answers at Sarvam's own paths, so only the base URL and the credential change.
 *
 * Sockets are opened by a factory. In a browser the token rides as a subprotocol, since browsers
 * can't set WebSocket headers; Node passes the key as a header (`nodeSocket` in ../node.ts).
 */
export interface SarvamAuth {
  apiKey?: string;
  token?: string;
  /** Proxy origin, e.g. https://drishti-proxy.example.workers.dev. Default: Sarvam itself. */
  baseUrl?: string;
  socket?: SocketFactory;
}

export type SocketFactory = (url: string, auth: SarvamAuth) => WebSocket;

const SARVAM = "https://api.sarvam.ai";

export function requireKey(auth: SarvamAuth) {
  if (!auth.apiKey && !auth.token) throw new Error("No Sarvam credential: set SARVAM_API_KEY, or sign in to the Drishti proxy.");
}

export function authHeaders(auth: SarvamAuth): Record<string, string> {
  return auth.token ? { authorization: `Bearer ${auth.token}` } : { "api-subscription-key": auth.apiKey ?? "" };
}

export function apiUrl(auth: SarvamAuth, path: string) {
  return `${(auth.baseUrl ?? SARVAM).replace(/\/$/, "")}${path}`;
}

/** The browser way: a device token as the subprotocol. A key can't be sent from a browser socket. */
export const browserSocket: SocketFactory = (url, auth) => {
  if (!auth.token)
    throw new Error("A browser can't send the Sarvam key on a WebSocket: connect through the Drishti proxy with a device token.");
  return new WebSocket(url, ["drishti", auth.token]);
};

export function openSocket(auth: SarvamAuth, pathAndQuery: string): WebSocket {
  requireKey(auth);
  const url = apiUrl(auth, pathAndQuery).replace(/^http/, "ws");
  return (auth.socket ?? browserSocket)(url, auth);
}

/** The proxy said no for a reason worth telling the user: everyone is busy, or today's quota is used. */
export class LimitError extends Error {
  constructor(
    readonly code: "busy" | "quota" | "slow_down" | "unauthorized",
    readonly retryAfterS = 0,
  ) {
    super(`Drishti proxy: ${code}`);
    this.name = "LimitError";
  }
}

/** A LimitError for the proxy's own refusals, else undefined (a Sarvam error to handle as before). */
export async function limitError(res: Response): Promise<LimitError | undefined> {
  if (res.status !== 429 && res.status !== 401) return undefined;
  const body = (await res
    .clone()
    .json()
    .catch(() => ({}))) as { error?: string };
  const code = body.error;
  if (code === "busy" || code === "quota" || code === "slow_down" || code === "unauthorized")
    return new LimitError(code, Number(res.headers.get("retry-after") ?? 0));
  return undefined;
}
