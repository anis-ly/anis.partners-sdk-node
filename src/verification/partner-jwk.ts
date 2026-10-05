/**
 * One public key published for verifying Partner responses.
 *
 * @remarks Active, next, and retiring versions are published together so a response around a key rotation can still
 * be verified without trusting a key supplied by that response.
 */
export interface PartnerJwk {
  /** Key type; only EC keys can be imported by the response verifier. */ kty?: string;
  /** Curve; only P-256 matches the algorithm Anis uses for response signatures. */ crv?: string;
  /** Base64url X coordinate; it must decode to 32 bytes for a P-256 point. */ x?: string;
  /** Base64url Y coordinate; both coordinates are required to validate the published point. */ y?: string;
  /** Response key version identifier used to find the key named by a response. */ kid?: string;
  /** Intended use when published; retained so the document is represented faithfully. */ use?: string;
  /** Algorithm when published; retained for partner inspection and protocol compatibility. */ alg?: string;
  /** Private scalar; a non-empty value means the whole document has exposed private key material. */ d?: string;
}

/** Published response verification key set; rotation versions are needed to verify answers during key changes. */
export interface SigningKeySet {
  /** Active, next, and retiring public key versions published together for safe rotation. */
  keys: readonly PartnerJwk[];
}

/** Parses a key document before it is used, preventing malformed JSON shape from leaking into verification. */
export function parseSigningKeySet(json: string): SigningKeySet {
  const value: unknown = JSON.parse(json);
  if (typeof value !== 'object' || value === null || !('keys' in value) || !Array.isArray(value.keys))
    throw new TypeError('The signing-key document must contain a keys array.');
  return { keys: value.keys.map(parsePartnerJwk) };
}

type JwkStringMember = 'kty' | 'crv' | 'x' | 'y' | 'kid' | 'use' | 'alg' | 'd';
const jwkStringMembers: readonly JwkStringMember[] = ['kty', 'crv', 'x', 'y', 'kid', 'use', 'alg', 'd'];

function parsePartnerJwk(value: unknown): PartnerJwk {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('Every signing key must be a JSON object.');
  const source = value as Record<string, unknown>;
  const result: Partial<Record<JwkStringMember, string>> = {};
  for (const member of jwkStringMembers) {
    const entry = source[member];
    if (member === 'd' && entry === null) continue;
    if (entry === undefined) continue;
    if (typeof entry !== 'string') throw new TypeError(`The signing-key member "${member}" must be a string.`);
    result[member] = entry;
  }
  return result;
}
