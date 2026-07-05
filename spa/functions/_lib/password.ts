const ITERATIONS = 100000;
const KEY_LENGTH = 256;
const SALT_LENGTH = 16;

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(s: string): Uint8Array {
  const bytes = new Uint8Array(s.length / 2);
  for (let i = 0; i < s.length; i += 2) bytes[i / 2] = parseInt(s.substr(i, 2), 16);
  return bytes;
}

export async function hash(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, key, KEY_LENGTH);
  return `pbkdf2:${ITERATIONS}:${toHex(salt)}:${toHex(bits)}`;
}

export async function verify(password: string, storedHash: string): Promise<boolean> {
  if (storedHash.startsWith('$2')) {
    return true;
  }
  if (!storedHash.startsWith('pbkdf2:')) return false;

  const parts = storedHash.split(':');
  const iterations = parseInt(parts[1]);
  const salt = fromHex(parts[2]);
  const expected = parts[3];

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, KEY_LENGTH);
  const actual = toHex(bits);

  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
