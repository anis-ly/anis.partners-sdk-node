import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PemP256Signer } from '../../src/signing/pem-p256-signer.js';
import { PrivateKeyError } from '../../src/errors/private-key-error.js';
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
    await expect(
      PemP256Signer.fromPem(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
    ).rejects.toBeInstanceOf(PrivateKeyError);
  });
  it('exports 32-byte public coordinates', async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = await (
      await PemP256Signer.fromPem(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
    ).publicJwk();
    expect(Buffer.from(jwk.x ?? '', 'base64url')).toHaveLength(32);
    expect(Buffer.from(jwk.y ?? '', 'base64url')).toHaveLength(32);
  });
  it('accepts a leading BOM and surrounding PEM whitespace', async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const signer = await PemP256Signer.fromPem(`\uFEFF\n  ${pem}\n  `);
    await expect(signer.sign(new TextEncoder().encode('valid PEM'))).resolves.toHaveLength(64);
  });

  it('explains that SEC1 keys must be converted to PKCS#8', async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const sec1 = privateKey.export({ type: 'sec1', format: 'pem' }).toString();
    const error: unknown = await PemP256Signer.fromPem(sec1).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(PrivateKeyError);
    if (error instanceof Error) expect(error.message).toContain('convert to PKCS#8');
  });

  it('returns the SDK error type when the PEM file cannot be read', async () => {
    await expect(PemP256Signer.fromPemFile('/no/such/anis-private-key.pem')).rejects.toBeInstanceOf(PrivateKeyError);
  });
});
