import { describe, expect, it } from 'vitest';
import { KeyedSigner } from '../../src/signing/keyed-signer.js';
import { PartnerRequestSigner } from '../../src/signing/partner-request-signer.js';
import { RequestSigningError } from '../../src/signing/request-signing-error.js';
import type { P256Signer } from '../../src/signing/p256-signer.js';
import type { SignatureInputs } from '../../src/signing/signature-inputs.js';

const readInputs: SignatureInputs = {
  method: 'GET',
  authority: 'partners.anis.ly',
  path: '/v1/profile',
  canonicalQuery: '',
  anisDate: '2026-10-05T00:00:00Z',
};
const keyId = '3f2a9c14-8d6e-4b21-9f07-5c8ab2d61e43';
const signerReturning = (signature: Uint8Array): P256Signer => ({ sign: () => Promise.resolve(signature) });

describe('partner request signer', () => {
  it('wraps a 71-byte signer result without exposing signed material', async () => {
    const signer = new PartnerRequestSigner(new KeyedSigner(signerReturning(new Uint8Array(71)), keyId));
    await expect(signer.sign('SafeRead', readInputs, 100, 160)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof RequestSigningError &&
        !error.message.includes('signature') &&
        !error.message.includes('Signature') &&
        !error.message.includes('partners.anis.ly'),
    );
  });
  it('preserves the signer rejection as its cause', async () => {
    const cause = new Error('vault is unavailable');
    const signer = new PartnerRequestSigner(new KeyedSigner({ sign: () => Promise.reject(cause) }, keyId));
    await expect(signer.sign('SafeRead', readInputs, 100, 160)).rejects.toMatchObject({ cause });
    await expect(signer.sign('SafeRead', readInputs, 100, 160)).rejects.toThrow(RequestSigningError);
  });
  it('refuses a nonce on a safe read', async () => {
    const signer = new PartnerRequestSigner(new KeyedSigner(signerReturning(new Uint8Array(64)), keyId));
    await expect(signer.sign('SafeRead', { ...readInputs, nonce: 'abc' }, 100, 160)).rejects.toThrow(/nonce/);
  });
  it('refuses a missing mutation nonce', async () => {
    const signer = new PartnerRequestSigner(new KeyedSigner(signerReturning(new Uint8Array(64)), keyId));
    await expect(
      signer.sign(
        'BodylessNonceMutation',
        { ...readInputs, contentDigest: 'sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:' },
        100,
        160,
      ),
    ).rejects.toThrow(/nonce/);
  });
  it('refuses a signature lifetime above 300 seconds', async () => {
    const signer = new PartnerRequestSigner(new KeyedSigner(signerReturning(new Uint8Array(64)), keyId));
    await expect(signer.sign('SafeRead', readInputs, 100, 401)).rejects.toThrow(/300 seconds/);
  });
});
