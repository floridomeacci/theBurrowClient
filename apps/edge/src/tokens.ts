/** Short-lived signed match tokens (spec §22.4).
 *  Payload: matchId, playerName, buildVersion, expiry, nonce. HMAC-SHA256. */

export interface MatchTokenPayload {
  matchId: string;
  name: string;
  build: string;
  exp: number; // unix seconds
  nonce: string;
}

const encoder = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify"
  ]);
}

function b64url(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const raw = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function signMatchToken(payload: MatchTokenPayload, secret: string): Promise<string> {
  if (secret.length < 32) throw new Error("MATCH_TOKEN_SECRET must contain at least 32 characters");
  const body = b64url(encoder.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `${body}.${b64url(sig)}`;
}

export async function verifyMatchToken(token: string, secret: string): Promise<MatchTokenPayload | null> {
  if (token.length > 2048 || secret.length < 32) return null;
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [body, sig] = parts;
    if (!body || !sig) return null;
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify("HMAC", key, fromB64url(sig), encoder.encode(body));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body))) as MatchTokenPayload;
    if (
      typeof payload.matchId !== "string" ||
      payload.matchId.length === 0 ||
      payload.matchId.length > 64 ||
      typeof payload.name !== "string" ||
      payload.name.length === 0 ||
      payload.name.length > 16 ||
      typeof payload.build !== "string" ||
      payload.build.length > 32 ||
      typeof payload.exp !== "number" ||
      !Number.isFinite(payload.exp) ||
      payload.exp < Date.now() / 1000 ||
      payload.exp > Date.now() / 1000 + 300 ||
      typeof payload.nonce !== "string" ||
      payload.nonce.length < 8 ||
      payload.nonce.length > 64
    ) return null;
    return payload;
  } catch {
    return null;
  }
}
