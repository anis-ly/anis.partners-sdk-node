import { describe, expect, it, vi } from 'vitest';
import { PartnerResponseVerifier } from '../../src/verification/partner-response-verifier.js';
import type { SigningKeySet } from '../../src/verification/partner-jwk.js';
import { UnverifiableResponseError } from '../../src/verification/unverifiable-response-error.js';
import type { VerifiableResponse } from '../../src/verification/verifiable-response.js';
import { signedFetchDouble } from '../support/signed-fetch.js';

const fake = await signedFetchDouble(() => ({ body: '{}' }));
const requestSignatureInput = 'sig1=("@method");created=1;keyid="test"';
const requestSignature = 'sig1=:raw-request-signature:';
const received = await fake.fetcher('https://partners.example/v1/orders/test', {
  headers: { 'Signature-Input': requestSignatureInput, Signature: requestSignature },
});
const response: VerifiableResponse = {
  status: received.status,
  headers: {
    'Content-Digest': received.headers.get('Content-Digest') ?? '',
    'X-Request-Id': received.headers.get('X-Request-Id') ?? '',
    'Cache-Control': received.headers.get('Cache-Control') ?? '',
    'Signature-Input': received.headers.get('Signature-Input') ?? '',
    Signature: received.headers.get('Signature') ?? '',
  },
  body: new Uint8Array(await received.arrayBuffer()),
  requestSignatureInput,
  requestSignature,
};
delete (response.headers as Record<string, string>)['signature-input'];
delete (response.headers as Record<string, string>).signature;
const created = Number(/created=(\d+)/.exec(response.headers['Signature-Input'] ?? '')?.[1]);
const fixture = { signingKeys: fake.keySet, verifyAt: created };

describe('partner response verifier', () => {
  it('accepts a response exactly sixty whole seconds old at a fractional clock time', async () => {
    const verifier = new PartnerResponseVerifier(
      { get: () => Promise.resolve(fixture.signingKeys), refresh: () => Promise.resolve(fixture.signingKeys) },
      { now: () => new Date((created + 60) * 1000 + 999) },
    );
    await expect(verifier.verify(response)).resolves.toBeUndefined();
  });
  it('refuses a response sixty-one whole seconds old at a fractional clock time', async () => {
    const verifier = new PartnerResponseVerifier(
      { get: () => Promise.resolve(fixture.signingKeys), refresh: () => Promise.resolve(fixture.signingKeys) },
      { now: () => new Date((created + 61) * 1000 + 999) },
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

describe('v2 response profile and key lifecycle', () => {
  const verify = (answer: VerifiableResponse, keys: SigningKeySet = fixture.signingKeys) =>
    new PartnerResponseVerifier(
      { get: () => Promise.resolve(keys), refresh: () => Promise.resolve(keys) },
      { now: () => new Date(created * 1000) },
    ).verify(answer);
  it.each([undefined, 'anis-response-v1', 'unexpected'])('rejects tag %s', async (tag) => {
    const input = (response.headers['Signature-Input'] ?? '').replace(
      ';tag="anis-response-v2"',
      tag === undefined ? '' : `;tag="${tag}"`,
    );
    await expect(
      verify({ ...response, headers: { ...response.headers, 'Signature-Input': input } }),
    ).rejects.toMatchObject({ failure: 'profile_unexpected' });
  });
  it('binds the raw request signature value', async () => {
    await expect(verify(response)).resolves.toBeUndefined();
    await expect(verify({ ...response, requestSignature: 'sig1=:another-signature:' })).rejects.toMatchObject({
      failure: 'signature_invalid',
    });
  });
  it('requires both request headers in the exact covered order', async () => {
    const input = (response.headers['Signature-Input'] ?? '').replace(' "signature";req', '');
    await expect(
      verify({ ...response, headers: { ...response.headers, 'Signature-Input': input } }),
    ).rejects.toMatchObject({ failure: 'covered_components_mismatch' });
    const missing = { ...response };
    delete missing.requestSignature;
    await expect(verify(missing)).rejects.toMatchObject({ failure: 'covered_components_mismatch' });
  });
  it.each([false, true])('rejects a compromised key with published=%s', async (published) => {
    const kid = fixture.signingKeys.keys[0]?.kid ?? '';
    await expect(
      verify(response, {
        keys: published ? fixture.signingKeys.keys : [],
        revoked: [{ kid, compromisedAt: new Date(created * 1000).toISOString() }],
      }),
    ).rejects.toMatchObject({ failure: 'key_compromised' });
  });
  it.each([undefined, 'unsupported'])('rejects missing or unsupported status %s', async (status) => {
    const keys = { keys: fixture.signingKeys.keys.map((key) => ({ ...key, status })) } as SigningKeySet;
    await expect(verify(response, keys)).rejects.toMatchObject({ failure: 'key_rejected' });
  });
  it.each([undefined, 'unparseable'])('rejects missing or unparseable notBefore %s', async (notBefore) => {
    const keys: SigningKeySet = {
      keys: fixture.signingKeys.keys.map((key) => {
        const malformed = { ...key };
        if (notBefore === undefined) delete malformed.notBefore;
        else malformed.notBefore = notBefore;
        return malformed;
      }),
    };
    await expect(verify(response, keys)).rejects.toMatchObject({ failure: 'key_rejected' });
  });
  it.each([undefined, 'unparseable'])('rejects missing or unparseable retiredAt %s', async (retiredAt) => {
    const keys: SigningKeySet = {
      keys: fixture.signingKeys.keys.map((key) => ({
        ...key,
        status: 'retired',
        ...(retiredAt === undefined ? {} : { retiredAt }),
      })),
    };
    await expect(verify(response, keys)).rejects.toMatchObject({ failure: 'key_rejected' });
  });
  it.each([
    ['retired', -1, 'key_retired'],
    ['next', 1, 'key_not_yet_valid'],
    ['retired', 0, undefined],
    ['next', 0, undefined],
    ['retired', 1, undefined],
    ['next', -1, undefined],
  ] as const)('checks %s at offset %s', async (status, offset, failure) => {
    const boundary = new Date((created + offset) * 1000).toISOString();
    const keys: SigningKeySet = {
      keys: fixture.signingKeys.keys.map((key) => ({
        ...key,
        status,
        notBefore: status === 'next' ? boundary : new Date((created - 100) * 1000).toISOString(),
        ...(status === 'retired' ? { retiredAt: boundary } : {}),
      })),
    };
    if (failure) await expect(verify(response, keys)).rejects.toMatchObject({ failure });
    else await expect(verify(response, keys)).resolves.toBeUndefined();
  });
});
