const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const SITE_SESSION_COOKIE = "__Host-burrow_session";
export const SITE_SESSION_TTL_SECONDS = 12 * 60 * 60;

interface SiteSessionPayload {
  exp: number;
  nonce: string;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string): Uint8Array | null {
  if (!/^[0-9a-f]+$/.test(value) || value.length % 2 !== 0) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function toBase64Url(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padding = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i]! ^ right[i]!;
  return difference === 0;
}

async function derivePassword(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256
  );
  return new Uint8Array(bits);
}

/** Create a portable password verifier. The returned value is safe for an
 * encrypted secret store, but must not be committed alongside the app. */
export async function createSitePasswordHash(
  password: string,
  iterations = 310_000,
  suppliedSalt?: Uint8Array
): Promise<string> {
  if (password.length < 12 || password.length > 256) throw new Error("site password length is invalid");
  if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 1_000_000) {
    throw new Error("password iteration count is invalid");
  }
  const salt = suppliedSalt ?? crypto.getRandomValues(new Uint8Array(16));
  if (salt.length !== 16) throw new Error("password salt must contain 16 bytes");
  const digest = await derivePassword(password, salt, iterations);
  return `v1$${iterations}$${toHex(salt)}$${toHex(digest)}`;
}

export async function verifySitePassword(password: string, storedHash: string): Promise<boolean> {
  if (password.length > 256) return false;
  const [version, rawIterations, rawSalt, rawDigest, extra] = storedHash.split("$");
  const iterations = Number(rawIterations);
  const salt = rawSalt ? fromHex(rawSalt) : null;
  const expected = rawDigest ? fromHex(rawDigest) : null;
  if (
    version !== "v1" ||
    extra !== undefined ||
    !Number.isInteger(iterations) ||
    iterations < 100_000 ||
    iterations > 1_000_000 ||
    salt?.length !== 16 ||
    expected?.length !== 32
  ) return false;
  const actual = await derivePassword(password, salt, iterations);
  return constantTimeEqual(actual, expected);
}

async function sessionKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error("SITE_SESSION_SECRET must contain at least 32 characters");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify"
  ]);
}

export async function issueSiteSession(
  secret: string,
  nowMs = Date.now(),
  ttlSeconds = SITE_SESSION_TTL_SECONDS
): Promise<string> {
  const payload: SiteSessionPayload = {
    exp: Math.floor(nowMs / 1000) + ttlSeconds,
    nonce: crypto.randomUUID()
  };
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", await sessionKey(secret), encoder.encode(body));
  return `${body}.${toBase64Url(signature)}`;
}

export async function verifySiteSession(
  token: string,
  secret: string,
  nowMs = Date.now()
): Promise<SiteSessionPayload | null> {
  if (token.length > 2048 || secret.length < 32) return null;
  try {
    const [body, signature, extra] = token.split(".");
    if (!body || !signature || extra !== undefined) return null;
    const valid = await crypto.subtle.verify(
      "HMAC",
      await sessionKey(secret),
      fromBase64Url(signature),
      encoder.encode(body)
    );
    if (!valid) return null;
    const payload = JSON.parse(decoder.decode(fromBase64Url(body))) as SiteSessionPayload;
    const nowSeconds = nowMs / 1000;
    if (
      typeof payload.exp !== "number" ||
      !Number.isFinite(payload.exp) ||
      payload.exp < nowSeconds ||
      payload.exp > nowSeconds + SITE_SESSION_TTL_SECONDS + 60 ||
      typeof payload.nonce !== "string" ||
      !/^[0-9a-f-]{36}$/.test(payload.nonce)
    ) return null;
    return payload;
  } catch {
    return null;
  }
}

export function readCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator > 0 && trimmed.slice(0, separator) === name) return trimmed.slice(separator + 1);
  }
  return null;
}

export function siteSessionCookie(token: string): string {
  return `${SITE_SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SITE_SESSION_TTL_SECONDS}`;
}

export function clearedSiteSessionCookie(): string {
  return `${SITE_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[character]!);
}

export function loginPage(message = ""): string {
  const notice = message ? `<p class="notice" role="alert">${escapeHtml(message)}</p>` : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>Private Preview</title>
    <style>
      :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: #080b0d; color: #eef2ee; }
      main { width: min(100%, 420px); padding: 32px; border: 1px solid #34413c; border-radius: 14px; background: #111714; box-shadow: 0 24px 80px #0008; }
      h1 { margin: 0 0 8px; font-size: 1.65rem; }
      p { color: #aebbb4; line-height: 1.5; }
      label { display: block; margin: 24px 0 8px; font-weight: 700; }
      input, button { width: 100%; border-radius: 8px; font: inherit; }
      input { padding: 12px 14px; border: 1px solid #52635b; background: #080b0d; color: #fff; }
      input:focus { outline: 2px solid #73d39d; outline-offset: 2px; }
      button { margin-top: 14px; padding: 12px 16px; border: 0; background: #73d39d; color: #07110b; font-weight: 800; cursor: pointer; }
      .notice { padding: 10px 12px; border-left: 3px solid #e07a67; background: #2b1715; color: #ffd8d1; }
    </style>
  </head>
  <body>
    <main>
      <h1>Private preview</h1>
      <p>This game is access-restricted. Enter the project password to continue.</p>
      ${notice}
      <form action="/api/auth" method="post">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" minlength="12" maxlength="256" required autofocus />
        <button type="submit">Enter game</button>
      </form>
    </main>
  </body>
</html>`;
}
