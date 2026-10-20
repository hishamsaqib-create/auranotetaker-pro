import { describe, expect, it } from 'vitest';
import { AesGcmContentCipher, ContentCipherError } from './cipher.ts';

const KEY = Buffer.alloc(32, 7).toString('base64');

describe('AesGcmContentCipher', () => {
  it('round-trips text and never stores it in the clear', async () => {
    const c = await AesGcmContentCipher.fromBase64Key(KEY);
    const sealed = await c.encrypt('Lower left six, distal chip.', 'transcript:clinic:s1:seg1');
    expect(sealed).not.toContain('Lower');
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(await c.decrypt(sealed, 'transcript:clinic:s1:seg1')).toBe('Lower left six, distal chip.');
  });

  it('uses a fresh IV each time', async () => {
    const c = await AesGcmContentCipher.fromBase64Key(KEY);
    expect(await c.encrypt('same', 'ctx')).not.toBe(await c.encrypt('same', 'ctx'));
  });

  it('refuses content moved to another session or record', async () => {
    const c = await AesGcmContentCipher.fromBase64Key(KEY);
    const sealed = await c.encrypt('note', 'nurse-note:clinic:s1');
    await expect(c.decrypt(sealed, 'nurse-note:clinic:s2')).rejects.toBeInstanceOf(ContentCipherError);
  });

  it('refuses another key, tampering and unknown formats', async () => {
    const a = await AesGcmContentCipher.fromBase64Key(KEY);
    const b = await AesGcmContentCipher.fromBase64Key(Buffer.alloc(32, 9).toString('base64'));
    const sealed = await a.encrypt('note', 'ctx');
    await expect(b.decrypt(sealed, 'ctx')).rejects.toBeInstanceOf(ContentCipherError);
    const tampered = sealed.slice(0, -4) + (sealed.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    await expect(a.decrypt(tampered, 'ctx')).rejects.toBeInstanceOf(ContentCipherError);
    await expect(a.decrypt('plain text', 'ctx')).rejects.toBeInstanceOf(ContentCipherError);
  });

  it('refuses keys that are not 32 bytes', async () => {
    await expect(AesGcmContentCipher.fromBase64Key(Buffer.alloc(16).toString('base64'))).rejects.toBeInstanceOf(ContentCipherError);
    await expect(AesGcmContentCipher.fromBase64Key('not base64!!')).rejects.toBeInstanceOf(ContentCipherError);
  });
});
