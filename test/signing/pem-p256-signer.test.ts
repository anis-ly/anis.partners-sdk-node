import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PemP256Signer } from '../../src/signing/pem-p256-signer.js';
import { arrayBufferOf } from '../../src/internal/bytes.js';

describe('PEM P-256 signer', () => {
  it('returns signatures that verify as P1363', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const signer = await PemP256Signer.fromPem(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
    const message = new TextEncoder().encode('signing check');
    const signature = await signer.sign(message);
    expect(signature).toHaveLength(64);
    const jwk = await signer.publicJwk();
    if (!jwk.x || !jwk.y) throw new Error('The public key must export both coordinates.');
    const imported = await globalThis.crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    await expect(
      globalThis.crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        imported,
        arrayBufferOf(signature),
        arrayBufferOf(message),
      ),
    ).resolves.toBe(true);
    expect(publicKey.asymmetricKeyType).toBe('ec');
  });
  it('refuses P-384 keys at load time', async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
    await expect(PemP256Signer.fromPem(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())).rejects.toThrow(
      /P-256/,
    );
  });
  it('exports 32-byte public coordinates', async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = await (
      await PemP256Signer.fromPem(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
    ).publicJwk();
    expect(Buffer.from(jwk.x ?? '', 'base64url')).toHaveLength(32);
    expect(Buffer.from(jwk.y ?? '', 'base64url')).toHaveLength(32);
  });
});
