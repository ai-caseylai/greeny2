/**
 * auth.ts — JWT + PBKDF2 via Web Crypto API
 *
 * Zero npm dependencies. All crypto via crypto.subtle (available in Workers).
 */

// ── Base64URL Helpers ─────────────────────────────────────────────────────

function base64url(buf: ArrayBuffer): string {
  // Standard base64 → base64url
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlDecode(str: string): string {
  // base64url → standard base64 → decode
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return atob(str);
}

// ── Text Encode/Decode ────────────────────────────────────────────────────

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ── JWT: signJWT ──────────────────────────────────────────────────────────

export async function signJWT(
  payload: Record<string, unknown>,
  secret: string,
  expiresInSec = 86400  // 24-hour default
): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat: now, exp: now + expiresInSec };
  const headerB64 = base64url(encoder.encode(JSON.stringify(header)));
  const payloadB64 = base64url(encoder.encode(JSON.stringify(fullPayload)));
  const message = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  const sigB64 = base64url(sig);

  return `${message}.${sigB64}`;
}

// ── JWT: verifyJWT ────────────────────────────────────────────────────────

export async function verifyJWT(
  token: string,
  secret: string
): Promise<Record<string, unknown> | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, sigB64] = parts;
    const message = `${headerB64}.${payloadB64}`;

    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    // Convert base64url sig to ArrayBuffer
    const sigStr = base64urlDecode(sigB64);
    const sigBytes = new Uint8Array(sigStr.length);
    for (let i = 0; i < sigStr.length; i++) sigBytes[i] = sigStr.charCodeAt(i);

    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes.buffer,
      encoder.encode(message)
    );

    if (!valid) return null;

    // Decode payload
    const payloadJson = base64urlDecode(payloadB64);
    const payload = JSON.parse(payloadJson);

    // Check expiry
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

// ── Password: hashPassword (PBKDF2) ────────────────────────────────────────

export async function hashPassword(
  password: string,
  salt: string
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: encoder.encode(salt),
      iterations: 100_000,
      hash: "SHA-256",
    },
    key,
    256
  );

  return base64url(bits);
}

// ── Password: verifyPassword ───────────────────────────────────────────────

export async function verifyPassword(
  password: string,
  salt: string,
  hash: string
): Promise<boolean> {
  const computed = await hashPassword(password, salt);
  return computed === hash;
}

// ── Random Helpers ─────────────────────────────────────────────────────────

export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomSalt(): string {
  return randomHex(16);
}
