import { inspect } from 'node:util';
import type { RequestSigner } from './p256-signer.js';
import { RequestSigningError } from './request-signing-error.js';
import { PartnerRequestSignatureBase } from './partner-request-signature-base.js';
import { componentsOf, type SignatureProfile } from './signature-profile.js';
import { canonicalizeSignatureInputs, type SignatureInputs } from './signature-inputs.js';
import type { SignedRequestHeaders } from './signed-request-headers.js';

/**
 * Signs one request profile and returns the headers that must be set on that attempt.
 *
 * @remarks Signing is kept after the final body is known so `Content-Digest` covers the bytes that actually leave the
 * process; a signer failure or wrong signature form means nothing is sent.
 */
export class PartnerRequestSigner {
  /** Creates a signer backed by partner-owned key custody; the private key never enters this API. */
  constructor(private readonly signer: RequestSigner) {}

  /** Builds and signs one attempt; errors retain the signer cause without exposing the base or signature in the message. */
  async sign(
    profile: SignatureProfile,
    source: SignatureInputs,
    created: number,
    expires: number,
  ): Promise<SignedRequestHeaders> {
    const inputs = canonicalizeSignatureInputs(source);
    if ((profile === 'SafeRead') !== (inputs.nonce === undefined))
      throw new TypeError('The nonce does not match the selected signature profile.');
    for (const name of componentsOf(profile)) {
      if (name === 'content-digest' && inputs.contentDigest === undefined)
        throw new TypeError('The selected profile requires Content-Digest.');
      if (name === 'idempotency-key' && inputs.idempotencyKey === undefined)
        throw new TypeError('The order profile requires a caller-owned idempotency key.');
    }
    const base = PartnerRequestSignatureBase.build(profile, inputs, created, expires, this.signer.keyId);
    let signature: Uint8Array;
    try {
      signature = await this.signer.sign(base);
    } catch (cause) {
      throw new RequestSigningError(cause);
    }
    if (signature.length !== 64)
      throw new RequestSigningError(
        new Error(
          `The signer returned ${String(signature.length)} bytes; P-256 P1363 requires 64 bytes. A 70–72 byte result is almost certainly DER.`,
        ),
      );
    const params = PartnerRequestSignatureBase.parameters(profile, created, expires, this.signer.keyId, inputs.nonce);
    return {
      signatureInput: PartnerRequestSignatureBase.signatureInputHeader(params),
      signature: PartnerRequestSignatureBase.signatureHeader(signature),
      anisDate: inputs.anisDate,
      ...(inputs.contentDigest === undefined ? {} : { contentDigest: inputs.contentDigest }),
      ...(inputs.nonce === undefined ? {} : { nonce: inputs.nonce }),
      ...(inputs.idempotencyKey === undefined ? {} : { idempotencyKey: inputs.idempotencyKey }),
      signatureBase: base,
      [inspect.custom]() {
        return 'SignedRequestHeaders { signatureInput: <redacted>, signature: <redacted>, nonce: <redacted>, signatureBase: <redacted> }';
      },
    };
  }
}
