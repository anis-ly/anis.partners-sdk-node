import { describe, expect, it } from 'vitest';
import { proofMessage, proofSignature } from '../../src/enrollment/enrollment-proof.js';
import { keyThumbprint } from '../../src/enrollment/key-thumbprint.js';
import { PemP256Signer } from '../../src/signing/pem-p256-signer.js';
import { importPublicJwk } from '../support/crypto.js';
import { readVector, vectorFiles, vectorId } from '../support/vectors.js';
import { arrayBufferOf } from '../../src/internal/bytes.js';

interface EnrollmentVector {
  id: string;
  key: { privateKeyPkcs8Base64: string; publicJwk: { kty: string; crv: string; x: string; y: string } };
  keySubmissionResult: { keyId: string; thumbprint: string; challenge: string; challengeGeneration: number };
  expected: { proofMessageBase64: string };
  exampleSignature: string;
}
const files = vectorFiles('enrollment', 'EP-');

describe('enrollment proof vectors', () => {
  it('contains both enrollment proof vectors', () => {
    expect(files).toHaveLength(2);
  });
  it.each(files.map((path) => ({ path, id: vectorId(path) })))(
    '$id builds and signs the declared proof message',
    async ({ path }) => {
      const vector = readVector(path, (value) => value as EnrollmentVector);
      const result = vector.keySubmissionResult;
      const thumbprint = keyThumbprint({ ...vector.key.publicJwk, kid: result.keyId });
      expect(thumbprint).toBe(result.thumbprint);
      expect(keyThumbprint({ ...vector.key.publicJwk, kid: result.keyId, d: 'ignored-private-member' })).toBe(
        thumbprint,
      );
      const message = proofMessage(result.keyId, result.challengeGeneration, result.challenge, result.thumbprint);
      expect(Buffer.from(message).toString('base64')).toBe(vector.expected.proofMessageBase64);
      const signer = await PemP256Signer.fromPem(
        `-----BEGIN PRIVATE KEY-----\n${vector.key.privateKeyPkcs8Base64}\n-----END PRIVATE KEY-----`,
      );
      const signature = await proofSignature(message, signer);
      expect(signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
      const publicKey = await importPublicJwk(vector.key.publicJwk);
      await expect(
        globalThis.crypto.subtle.verify(
          { name: 'ECDSA', hash: 'SHA-256' },
          publicKey,
          arrayBufferOf(Buffer.from(signature, 'base64url')),
          arrayBufferOf(message),
        ),
      ).resolves.toBe(true);
      await expect(
        globalThis.crypto.subtle.verify(
          { name: 'ECDSA', hash: 'SHA-256' },
          publicKey,
          arrayBufferOf(Buffer.from(vector.exampleSignature, 'base64url')),
          arrayBufferOf(message),
        ),
      ).resolves.toBe(true);
    },
  );

  it.each([
    ['a different curve', { kty: 'EC', crv: 'P-384', x: 'A'.repeat(43), y: 'A'.repeat(43), kid: 'id' }],
    ['an incomplete coordinate', { kty: 'EC', crv: 'P-256', x: '', y: 'A'.repeat(43), kid: 'id' }],
    ['a short coordinate', { kty: 'EC', crv: 'P-256', x: 'AAAA', y: 'A'.repeat(43), kid: 'id' }],
  ])('refuses a public key with %s before deriving a thumbprint', (_description, jwk) => {
    expect(() => keyThumbprint(jwk)).toThrow(TypeError);
  });

  it.each([
    ['an empty challenge', '', 'thumbprint'],
    ['an empty thumbprint', 'challenge', ''],
  ])('refuses a proof message with %s', (_description, challenge, thumbprint) => {
    expect(() => proofMessage('a9cb2df1-5a48-449b-8c8a-1b20a5b7f433', 1, challenge, thumbprint)).toThrow(TypeError);
  });
});
