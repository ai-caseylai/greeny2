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

// Self-describing hash format shared with Pages Functions:
//   pbkdf2:<iterations>:<hex salt>:<hex derived key>
// Keeping ONE format means a user row works identically on the Worker and on
// Pages Functions, and the row no longer depends on a separate `salt` column.

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) out[i / 2] = parseInt(hex.substr(i, 2), 16);
  return out;
}

async function derive(
  password: string,
  salt: Uint8Array,
  iterations: number
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    256
  );
  return toHex(bits);
}

/** Produce a `pbkdf2:...` hash for a new password. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await derive(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2:${PBKDF2_ITERATIONS}:${toHex(salt)}:${derived}`;
}

// ── Password: verifyPassword ───────────────────────────────────────────────
//
// Fail closed: anything that is not a `pbkdf2:` hash is rejected.
// The old code path returned `true` for bcrypt (`$2...`) hashes, which let
// anyone log in with ANY password. Never reintroduce that shortcut — migrate
// legacy bcrypt rows to the pbkdf2 format instead.

export async function verifyPassword(
  password: string,
  storedHash: string
): Promise<boolean> {
  if (!storedHash || !storedHash.startsWith("pbkdf2:")) return false;

  const parts = storedHash.split(":");
  if (parts.length !== 4) return false;

  const iterations = parseInt(parts[1], 10);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;

  const expected = parts[3];
  const actual = await derive(password, fromHex(parts[2]), iterations);

  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) {
    diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
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
