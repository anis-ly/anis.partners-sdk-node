import { describe, expect, it } from 'vitest';
import { contentDigestOf } from '../../src/signing/content-digest.js';
import { PartnerRequestSigner } from '../../src/signing/partner-request-signer.js';
import type { SignatureInputs } from '../../src/signing/signature-inputs.js';
import type { SignatureProfile } from '../../src/signing/signature-profile.js';
import { PemP256Signer } from '../../src/signing/pem-p256-signer.js';
import { importPublicJwk } from '../support/crypto.js';
import { readVector, vectorFiles, vectorId } from '../support/vectors.js';
import { arrayBufferOf } from '../../src/internal/bytes.js';

interface RequestVector {
  id: string;
  profile: SignatureProfile;
  key: { keyId: string; privateKeyPkcs8Base64: string; publicJwk: { kty: string; crv: string; x: string; y: string } };
  request: {
    method: string;
    authorityAsGiven: string;
    path: string;
    canonicalQuery: string;
    anisDate: string;
    nonce: string | null;
    idempotencyKey: string | null;
    bodyBase64: string | null;
  };
  signature: { created: number; expires: number };
  expected: { signatureBaseUtf8: string; signatureInput: string; contentDigest: string | null };
}
const files = vectorFiles('request', 'RQ-');

describe('request signing vectors', () => {
  it('contains all nine request vectors', () => {
    expect(files).toHaveLength(9);
  });
  it.each(files.map((path) => ({ path, id: vectorId(path) })))(
    '$id reproduces its signature base',
    async ({ path }) => {
      const vector = readVector(path, (value) => value as RequestVector);
      const pem = `-----BEGIN PRIVATE KEY-----\n${vector.key.privateKeyPkcs8Base64}\n-----END PRIVATE KEY-----`;
      const signer = await PemP256Signer.fromPem(pem);
      const body =
        vector.request.bodyBase64 === null
          ? undefined
          : new Uint8Array(Buffer.from(vector.request.bodyBase64, 'base64'));
      const inputs: SignatureInputs = {
        method: vector.request.method,
        authority: vector.request.authorityAsGiven,
        path: vector.request.path,
        canonicalQuery: vector.request.canonicalQuery,
        anisDate: vector.request.anisDate,
        ...(body === undefined ? {} : { contentDigest: contentDigestOf(body) }),
        ...(vector.request.nonce === null ? {} : { nonce: vector.request.nonce }),
        ...(vector.request.idempotencyKey === null ? {} : { idempotencyKey: vector.request.idempotencyKey }),
      };
      const signed = await new PartnerRequestSigner(signer.forKey(vector.key.keyId)).sign(
        vector.profile,
        inputs,
        vector.signature.created,
        vector.signature.expires,
      );
      expect(new TextDecoder().decode(signed.signatureBase)).toBe(vector.expected.signatureBaseUtf8);
      expect(signed.signatureInput).toBe(vector.expected.signatureInput);
      expect(signed.contentDigest ?? null).toBe(vector.expected.contentDigest);
      const bytes = Buffer.from(
        signed.signature.slice(signed.signature.indexOf(':') + 1, signed.signature.lastIndexOf(':')),
        'base64',
      );
      expect(bytes).toHaveLength(64);
      const publicKey = await importPublicJwk(vector.key.publicJwk);
      await expect(
        globalThis.crypto.subtle.verify(
          { name: 'ECDSA', hash: 'SHA-256' },
          publicKey,
          arrayBufferOf(bytes),
          arrayBufferOf(signed.signatureBase),
        ),
      ).resolves.toBe(true);
    },
  );
});
