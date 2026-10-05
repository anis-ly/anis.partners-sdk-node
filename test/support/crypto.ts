import type { PartnerJwk } from '../../src/verification/partner-jwk.js';

/** Imports a vector's P-256 public key for an independent signature check. */
export async function importPublicJwk(jwk: PartnerJwk): Promise<CryptoKey> {
  if (!jwk.x || !jwk.y) throw new TypeError('A vector public key must include x and y coordinates.');
  return globalThis.crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
}
