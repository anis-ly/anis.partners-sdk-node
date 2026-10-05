import { createHash } from 'node:crypto';
import { canonicalUuid } from '../internal/uuid.js';
import { encodeBase64Url } from '../internal/base64url.js';
import type { P256Signer } from '../signing/p256-signer.js';

/**
 * Domain separator checked by Anis when verifying credential possession.
 *
 * @remarks Including a distinct first line prevents a credential proof from being reused as another signature type.
 */
export const DOMAIN_SEPARATOR = 'anis.partners.v2.credential-proof';

/** Builds the exact domain-separated UTF-8 proof message so both sides hash the challenge and bind the same credential. */
export function proofMessage(
  keyId: string,
  challengeGeneration: number,
  challenge: string,
  thumbprint: string,
): Uint8Array {
  const hash = createHash('sha256').update(challenge, 'utf8').digest('hex');
  return new TextEncoder().encode(
    [DOMAIN_SEPARATOR, canonicalUuid(keyId), String(challengeGeneration), hash, thumbprint].join('\n'),
  );
}

/** Signs the proof message and returns unpadded base64url P1363 bytes; DER would be refused at the proof endpoint. */
export async function proofSignature(message: Uint8Array, signer: P256Signer): Promise<string> {
  const signature = await signer.sign(message);
  if (signature.length !== 64) throw new TypeError('An enrollment proof must be a 64-byte P-256 P1363 signature.');
  return encodeBase64Url(signature);
}
