import { canonicalUuid } from '../internal/uuid.js';

/**
 * Canonical request facts shared by the signature base and emitted headers.
 *
 * @remarks Each value is normalized once so the bytes signed and the headers sent cannot drift apart.
 */
export interface SignatureInputs {
  /** HTTP method in upper-case because the gateway upper-cases before rebuilding the signed request. */ method: string;
  /** Lower-case host and optional non-default port because the gateway compares the canonical authority. */ authority: string;
  /** Absolute request path; percent escapes are refused because the gateway verifies the decoded path. */ path: string;
  /** Raw query without a leading question mark so its original ordering and encoding are preserved. */ canonicalQuery: string;
  /** UTC date value covered by the signature and sent as X-Anis-Date. */ anisDate: string;
  /** Digest of the exact transmitted bytes; re-serializing the body would invalidate the request. */ contentDigest?: string;
  /** Fresh mutation nonce repeated in the header and signature parameters to prevent replay. */ nonce?: string;
  /** Caller-owned order UUID so retries keep the same operation identity. */ idempotencyKey?: string;
}

/**
 * Canonicalizes each request fact once, before the base builder and header writer share it.
 *
 * @remarks An upper-case method, lower-case authority, canonical operation UUID, and refused percent-escaped path
 * match the gateway's request envelope; normalizing later could sign values different from those sent.
 */
export function canonicalizeSignatureInputs(inputs: SignatureInputs): SignatureInputs {
  if (inputs.path.includes('%')) throw new TypeError('Paths containing percent escapes cannot be signed.');
  return {
    method: inputs.method.toUpperCase(),
    authority: inputs.authority.toLowerCase(),
    path: inputs.path,
    canonicalQuery: inputs.canonicalQuery,
    anisDate: inputs.anisDate,
    ...(inputs.contentDigest === undefined ? {} : { contentDigest: inputs.contentDigest }),
    ...(inputs.nonce === undefined ? {} : { nonce: inputs.nonce }),
    ...(inputs.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: canonicalUuid(inputs.idempotencyKey, 'idempotencyKey') }),
  };
}

/** Resolves a covered component from already-canonical facts. */
export function valueOf(inputs: SignatureInputs, component: string): string {
  const values: Record<string, string | undefined> = {
    '@method': inputs.method,
    '@authority': inputs.authority,
    '@path': inputs.path,
    '@query': `?${inputs.canonicalQuery}`,
    'content-digest': inputs.contentDigest,
    nonce: inputs.nonce,
    'idempotency-key': inputs.idempotencyKey,
    'x-anis-date': inputs.anisDate,
  };
  const value = values[component];
  if (value === undefined) throw new TypeError(`The covered component '${component}' has no value.`);
  return value;
}
