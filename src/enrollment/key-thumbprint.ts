import { createHash } from 'node:crypto';
import { decodeBase64Url, encodeBase64Url } from '../internal/base64url.js';
import type { PartnerJwk } from '../verification/partner-jwk.js';

/**
 * Computes the RFC 7638 fingerprint used to confirm the submitted key.
 *
 * @remarks Computing locally and comparing with Anis's answer catches a changed public key before a partner proves
 * possession of the wrong key.
 */
export function keyThumbprint(publicJwk: PartnerJwk): string {
  if (publicJwk.kty !== 'EC' || publicJwk.crv !== 'P-256')
    throw new TypeError('The key must be a public EC P-256 JWK.');
  const x = publicJwk.x;
  const y = publicJwk.y;
  if (!x || !y) throw new TypeError('A P-256 public key must include both coordinates.');
  for (const [name, value] of [
    ['x', x],
    ['y', y],
  ] as const)
    if (decodeBase64Url(value)?.length !== 32)
      throw new TypeError(`The JWK member "${name}" must be a 32-byte base64url coordinate.`);
  const canonical = `{"crv":"P-256","kty":"EC","x":"${x}","y":"${y}"}`;
  return encodeBase64Url(createHash('sha256').update(canonical, 'utf8').digest());
}
