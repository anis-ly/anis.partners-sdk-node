import { describe, expect, it, vi } from 'vitest';
import { PartnerResponseVerifier } from '../../src/verification/partner-response-verifier.js';
import type { SigningKeySet } from '../../src/verification/partner-jwk.js';
import { UnverifiableResponseError } from '../../src/verification/unverifiable-response-error.js';
import type { VerifiableResponse } from '../../src/verification/verifiable-response.js';
import { readVector, vectorFiles } from '../support/vectors.js';

interface ResponseFixture {
  verifyAt: number;
  request: { signatureInput: string | null };
  response: { status: number; headers: Record<string, string>; bodyBase64: string };
  signingKeys: SigningKeySet;
}
const acceptedPath = vectorFiles('response', 'RS-').find((path) => path.endsWith('RS-001-safe-read-profile-200.json'));
if (!acceptedPath) throw new Error('The baseline response vector is missing.');
const fixture = readVector(acceptedPath, (value) => value as ResponseFixture);
const response: VerifiableResponse = {
  status: fixture.response.status,
  headers: fixture.response.headers,
  body: new Uint8Array(Buffer.from(fixture.response.bodyBase64, 'base64')),
  ...(fixture.request.signatureInput ? { requestSignatureInput: fixture.request.signatureInput } : {}),
};

describe('partner response verifier', () => {
  it('accepts a response exactly sixty whole seconds old at a fractional clock time', async () => {
    const verifier = new PartnerResponseVerifier(
      { get: () => Promise.resolve(fixture.signingKeys), refresh: () => Promise.resolve(fixture.signingKeys) },
      { now: () => new Date(1789804860999) },
    );
    await expect(verifier.verify(response)).resolves.toBeUndefined();
  });
  it('refuses a response sixty-one whole seconds old at a fractional clock time', async () => {
    const verifier = new PartnerResponseVerifier(
      { get: () => Promise.resolve(fixture.signingKeys), refresh: () => Promise.resolve(fixture.signingKeys) },
      { now: () => new Date(1789804861999) },
    );
    await expect(verifier.verify(response)).rejects.toMatchObject({ failure: 'created_out_of_window' });
  });
  it('classifies a created value above the safe integer range as outside the freshness window', async () => {
    const verifier = new PartnerResponseVerifier(
      { get: () => Promise.resolve(fixture.signingKeys), refresh: () => Promise.resolve(fixture.signingKeys) },
      { now: () => new Date(fixture.verifyAt * 1000) },
    );
    const signatureInput = response.headers['Signature-Input'];
    if (signatureInput === undefined) throw new Error('Fixture signature input is missing.');
    const updated = signatureInput.replace(/created=\d+/, 'created=9007199254740993');

    await expect(
      verifier.verify({ ...response, headers: { ...response.headers, 'Signature-Input': updated } }),
    ).rejects.toMatchObject({ failure: 'created_out_of_window' });
  });
  it('rejects a well-sized off-curve public key', async () => {
    const keys = {
      keys: [
        {
          ...fixture.signingKeys.keys[0],
          x: Buffer.alloc(32).toString('base64url'),
          y: Buffer.alloc(32).toString('base64url'),
        },
      ],
    };
    const verifier = new PartnerResponseVerifier(
      { get: () => Promise.resolve(keys), refresh: () => Promise.resolve(keys) },
      { now: () => new Date(fixture.verifyAt * 1000) },
    );
    await expect(verifier.verify(response)).rejects.toMatchObject({ failure: 'key_rejected' });
  });
  it('refreshes once when the response names an unknown key', async () => {
    const get = vi.fn(() => Promise.resolve({ keys: [] } satisfies SigningKeySet));
    const refresh = vi.fn(() => Promise.resolve({ keys: [] } satisfies SigningKeySet));
    const verifier = new PartnerResponseVerifier({ get, refresh }, { now: () => new Date(fixture.verifyAt * 1000) });
    await expect(verifier.verify(response)).rejects.toMatchObject({ failure: 'unknown_key' });
    expect(get).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it('reports refusals with the public exception type', async () => {
    const verifier = new PartnerResponseVerifier(
      { get: () => Promise.resolve({ keys: [] }), refresh: () => Promise.resolve({ keys: [] }) },
      { now: () => new Date(fixture.verifyAt * 1000) },
    );
    await expect(verifier.verify({ ...response, headers: {} })).rejects.toBeInstanceOf(UnverifiableResponseError);
  });
  it('rejects a valid signature followed by trailing junk', async () => {
    const verifier = new PartnerResponseVerifier(
      { get: () => Promise.resolve(fixture.signingKeys), refresh: () => Promise.resolve(fixture.signingKeys) },
      { now: () => new Date(fixture.verifyAt * 1000) },
    );
    const signature = response.headers.Signature;
    if (signature === undefined) throw new Error('Fixture signature is missing.');

    await expect(
      verifier.verify({ ...response, headers: { ...response.headers, Signature: `${signature}junk` } }),
    ).rejects.toMatchObject({ failure: 'signature_malformed' });
  });
  it('rejects a valid signature encoded with nonzero base64 padding bits', async () => {
    const verifier = new PartnerResponseVerifier(
      { get: () => Promise.resolve(fixture.signingKeys), refresh: () => Promise.resolve(fixture.signingKeys) },
      { now: () => new Date(fixture.verifyAt * 1000) },
    );
    const signature = response.headers.Signature;
    if (signature === undefined) throw new Error('Fixture signature is missing.');
    const encoded = signature.slice('sig1=:'.length, -1);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const finalDataIndex = encoded.length - 3;
    const value = alphabet.indexOf(encoded[finalDataIndex] ?? '');
    const changed = alphabet[(value & 48) | ((value + 1) & 15)];
    if (changed === undefined) throw new Error('Fixture signature has invalid base64.');
    const noncanonical = `${encoded.slice(0, finalDataIndex)}${changed}==`;

    await expect(
      verifier.verify({ ...response, headers: { ...response.headers, Signature: `sig1=:${noncanonical}:` } }),
    ).rejects.toMatchObject({ failure: 'signature_malformed' });
  });
});
