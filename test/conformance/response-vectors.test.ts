import { describe, expect, it } from 'vitest';
import { PartnerResponseVerifier } from '../../src/verification/partner-response-verifier.js';
import type { SigningKeySet } from '../../src/verification/partner-jwk.js';
import type { ResponseVerificationFailure } from '../../src/verification/response-verification-failure.js';
import { UnverifiableResponseError } from '../../src/verification/unverifiable-response-error.js';
import type { VerifiableResponse } from '../../src/verification/verifiable-response.js';
import { readVector, vectorFiles, vectorId } from '../support/vectors.js';

interface ResponseVector {
  id: string;
  verifyAt: number;
  request: { signatureInput: string | null };
  response: { status: number; headers: Record<string, string>; bodyBase64: string };
  signingKeys: SigningKeySet;
  expected: { outcome: string; reason: ResponseVerificationFailure | null };
}
const files = vectorFiles('response', 'RS-');

describe('response verification vectors', () => {
  it('contains all thirty-nine response vectors', () => {
    expect(files).toHaveLength(39);
  });
  it.each(files.map((path) => ({ path, id: vectorId(path) })))('$id reaches its declared outcome', async ({ path }) => {
    const vector = readVector(path, (value) => value as ResponseVector);
    const response: VerifiableResponse = {
      status: vector.response.status,
      headers: vector.response.headers,
      body: new Uint8Array(Buffer.from(vector.response.bodyBase64, 'base64')),
      ...(vector.request.signatureInput === null ? {} : { requestSignatureInput: vector.request.signatureInput }),
    };
    const verifier = new PartnerResponseVerifier(
      { get: () => Promise.resolve(vector.signingKeys), refresh: () => Promise.resolve(vector.signingKeys) },
      { now: () => new Date(vector.verifyAt * 1000) },
    );
    if (vector.expected.outcome === 'accept') await expect(verifier.verify(response)).resolves.toBeUndefined();
    else {
      if (vector.expected.reason === null) throw new Error(`Rejected vector ${vector.id} has no declared reason.`);
      await expect(verifier.verify(response)).rejects.toMatchObject({
        failure: vector.expected.reason,
      } satisfies Partial<UnverifiableResponseError>);
    }
  });
});
