/**
 * One public key published for verifying Partner responses.
 *
 * @remarks Active, next, and retired versions are published together so a response around a key rotation can still
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

/** Response verification key with its published signing lifecycle. */
export interface PublishedSigningKey extends PartnerJwk {
  /** Signing purpose: answer for API responses, webhook for deliveries; legacy answer documents may omit it. */ purpose?: string;
  /** Published signing lifecycle state. */ status?: 'active' | 'next' | 'retired';
  /** Earliest signing instant in RFC3339 form. */ notBefore?: string;
  /** Instant the key stopped signing. */ retiredAt?: string;
}

/** Published response verification key set; rotation versions are needed to verify answers during key changes. */
export interface SigningKeySet {
  /** Active, next, and retired public key versions published together for safe rotation. */
  keys: readonly PublishedSigningKey[];
  /** Compromised keys must never verify responses. */
  revoked?: readonly RevokedSigningKey[];
}

/** A compromised response key published for rejection. */
export interface RevokedSigningKey {
  /** Compromised key version. */ kid: string;
  /** RFC3339 compromise instant. */ compromisedAt: string;
}

/** Parses a key document before it is used, preventing malformed JSON shape from leaking into verification. */
export function parseSigningKeySet(json: string): SigningKeySet {
  const value: unknown = JSON.parse(json);
  if (typeof value !== 'object' || value === null || !('keys' in value) || !Array.isArray(value.keys))
    throw new TypeError('The signing-key document must contain a keys array.');
  const revoked = 'revoked' in value ? value.revoked : [];
  if (!Array.isArray(revoked)) throw new TypeError('The revoked member must be an array.');
  return {
    keys: value.keys.map(parsePartnerJwk),
    revoked: revoked.map((entry: unknown) => {
      if (
        typeof entry !== 'object' ||
        entry === null ||
        !('kid' in entry) ||
        typeof entry.kid !== 'string' ||
        !('compromisedAt' in entry) ||
        typeof entry.compromisedAt !== 'string'
      )
        throw new TypeError('Invalid revoked signing key.');
      validateTimestamp(entry.compromisedAt);
      return { kid: entry.kid, compromisedAt: entry.compromisedAt };
    }),
  };
}

type JwkStringMember = 'kty' | 'crv' | 'x' | 'y' | 'kid' | 'use' | 'alg' | 'd' | 'purpose';
const jwkStringMembers: readonly JwkStringMember[] = ['kty', 'crv', 'x', 'y', 'kid', 'use', 'alg', 'd', 'purpose'];

function parsePartnerJwk(value: unknown): PublishedSigningKey {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('Every signing key must be a JSON object.');
  const source = value as Record<string, unknown>;
  const result: PublishedSigningKey = {};
  for (const member of jwkStringMembers) {
    const entry = source[member];
    if (member === 'd' && entry === null) continue;
    if (entry === undefined) continue;
    if (typeof entry !== 'string') throw new TypeError(`The signing-key member "${member}" must be a string.`);
    result[member] = entry;
  }
  const status = source.status;
  if (status !== undefined) {
    if (status !== 'active' && status !== 'next' && status !== 'retired')
      throw new TypeError('Invalid signing key status.');
    result.status = status;
  }
  for (const member of ['notBefore', 'retiredAt'] as const) {
    const value = source[member];
    if (value !== undefined) {
      if (typeof value !== 'string') throw new TypeError('Invalid signing key timestamp.');
      validateTimestamp(value);
      result[member] = value;
    }
  }
  if (
    (status !== undefined && source.notBefore === undefined) ||
    (status === 'retired' && source.retiredAt === undefined)
  )
    throw new TypeError('Missing signing key lifecycle timestamp.');
  return result;
}

function validateTimestamp(value: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new TypeError('Invalid signing key timestamp.');
}
