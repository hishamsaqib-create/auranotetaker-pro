// GENERATED from lib/server/cipher.ts by scripts/sync-base44-shared.mjs. Do not edit; edit lib/ instead.
// Encryption of clinical content while Base44 holds it (decision D2a). AES-256-GCM via Web Crypto,
// which browsers, Deno and Node all provide.
//
// SECURITY:
// - The key comes from the CONTENT_ENCRYPTION_KEY secret (32 random bytes, base64). It is never logged.
// - Each value is bound to where it belongs (clinic, session and record) as additional authenticated data,
//   so a stored value copied onto another session or patient fails to decrypt instead of showing.
// - A value that fails to decrypt is an error, never shown as empty.

const VERSION = 'v1';

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const s = atob(value);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}

export class ContentCipherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentCipherError';
  }
}

export interface ContentCipher {
  encrypt(plainText: string, context: string): Promise<string>;
  decrypt(cipherText: string, context: string): Promise<string>;
}

export class AesGcmContentCipher implements ContentCipher {
  private constructor(private readonly key: CryptoKey) {}

  /** From the base64 secret. Refuses anything that is not exactly 32 bytes. */
  static async fromBase64Key(secret: string): Promise<AesGcmContentCipher> {
    let raw: Uint8Array<ArrayBuffer>;
    try {
      raw = fromBase64(secret.trim());
    } catch {
      throw new ContentCipherError('The content encryption key is not valid base64.');
    }
    if (raw.length !== 32) throw new ContentCipherError('The content encryption key must be 32 bytes.');
    const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    return new AesGcmContentCipher(key);
  }

  /** A throwaway key, for demo mode and tests. */
  static async generate(): Promise<AesGcmContentCipher> {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    return new AesGcmContentCipher(key);
  }

  async encrypt(plainText: string, context: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode(plainText);
    const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(context) }, this.key, data);
    return `${VERSION}.${toBase64(iv)}.${toBase64(new Uint8Array(sealed))}`;
  }

  async decrypt(cipherText: string, context: string): Promise<string> {
    const parts = cipherText.split('.');
    if (parts.length !== 3 || parts[0] !== VERSION) throw new ContentCipherError('Stored content is in an unknown format.');
    try {
      const iv = fromBase64(parts[1]!);
      const sealed = fromBase64(parts[2]!);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(context) }, this.key, sealed);
      return new TextDecoder().decode(plain);
    } catch {
      throw new ContentCipherError('Stored content could not be decrypted.');
    }
  }
}
