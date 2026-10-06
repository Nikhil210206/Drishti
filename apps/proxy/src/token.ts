/**
 * Device tokens: stateless and signed, so checking one costs no storage read.
 *
 *   <base64url(JSON {v, d, i})>.<base64url(HMAC-SHA256(secret, payload))>
 *
 * `d` is a random device id (the quota key) and `i` the issue time. Rotating TOKEN_SECRET revokes
 * every token at once; devices then mint a new one through Turnstile.
 */
const enc = new TextEncoder();
const TTL_MS = 365 * 24 * 3600 * 1000;

export interface DeviceToken {
  device: string;
  issuedAt: number;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function key(secret: string) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function mintToken(secret: string, now = Date.now()): Promise<{ token: string; device: string }> {
  const device = crypto.randomUUID();
  const payload = b64url(enc.encode(JSON.stringify({ v: 1, d: device, i: now })));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), enc.encode(payload)));
  return { token: `${payload}.${b64url(sig)}`, device };
}

/** The device behind a token, or undefined when it is forged, malformed or expired. */
export async function verifyToken(secret: string, token: string | null | undefined, now = Date.now()): Promise<DeviceToken | undefined> {
  if (!token || token.length > 512) return undefined;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return undefined;
  try {
    const ok = await crypto.subtle.verify("HMAC", await key(secret), fromB64url(sig), enc.encode(payload));
    if (!ok) return undefined;
    const body = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    if (body.v !== 1 || typeof body.d !== "string" || typeof body.i !== "number") return undefined;
    if (now - body.i > TTL_MS || body.i > now + 60_000) return undefined;
    return { device: body.d, issuedAt: body.i };
  } catch {
    return undefined;
  }
}
