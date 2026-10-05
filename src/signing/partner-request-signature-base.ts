import { canonicalUuid } from '../internal/uuid.js';
import { componentsOf, type SignatureProfile } from './signature-profile.js';
import { valueOf, type SignatureInputs } from './signature-inputs.js';

/**
 * RFC 9421 request signature material built from one frozen component list.
 *
 * @remarks Building the input header and base from the same list prevents a request from advertising components
 * different from the ones its signature actually covers.
 */
export const PartnerRequestSignatureBase = {
  /** The sole signature label accepted by Anis; an alternate label is rejected before signature verification. */
  label: 'sig1',
  /** The only algorithm negotiated by neither side, preventing a fallback with different signature semantics. */
  algorithm: 'ecdsa-p256-sha256',
  /** The gateway's independent upper bound; longer windows are refused before a request can be accepted. */
  maxSignatureLifetimeSeconds: 300,

  /** Builds exact UTF-8 bytes; the final line has no newline because even one extra byte invalidates the signature. */
  build(
    profile: SignatureProfile,
    inputs: SignatureInputs,
    created: number,
    expires: number,
    keyId: string,
  ): Uint8Array {
    const nonce = inputs.nonce;
    const params = this.parameters(profile, created, expires, keyId, nonce);
    const lines = componentsOf(profile).map((component) => `"${component}": ${valueOf(inputs, component)}\n`);
    lines.push(`"@signature-params": ${params}`);
    return new TextEncoder().encode(lines.join(''));
  },

  /** Renders contract-ordered parameters, including the nonce only when the route profile requires it. */
  parameters(profile: SignatureProfile, created: number, expires: number, keyId: string, nonce?: string): string {
    if (expires - created > this.maxSignatureLifetimeSeconds)
      throw new RangeError('A Partner signature may live at most 300 seconds.');
    let invalidNonce = nonce === undefined || nonce.length === 0;
    if (nonce !== undefined)
      for (const character of nonce)
        if (character === '"' || character === '\\' || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
          invalidNonce = true;
    if (profile === 'SafeRead' ? nonce !== undefined : invalidNonce) {
      throw new TypeError('The nonce does not match the selected signature profile.');
    }
    const ids = componentsOf(profile)
      .map((part) => `"${part}"`)
      .join(' ');
    return `(${ids});created=${String(created)};expires=${String(expires)};keyid="${canonicalUuid(keyId)}";alg="${PartnerRequestSignatureBase.algorithm}"${nonce === undefined ? '' : `;nonce="${nonce}"`}`;
  },

  /** Renders the sole supported label with the same parameters used to build the signed bytes. */
  signatureInputHeader(parameters: string): string {
    return `${this.label}=${parameters}`;
  },
  /** Renders the exact P1363 bytes; converting to DER would make Anis refuse this otherwise valid signature. */
  signatureHeader(signature: Uint8Array): string {
    return `${this.label}=:${Buffer.from(signature).toString('base64')}:`;
  },
};
