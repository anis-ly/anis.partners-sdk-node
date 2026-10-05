import { inspect } from 'node:util';

/**
 * Headers created together from the same canonical request facts and signature base.
 *
 * @remarks Setting these values together prevents retries from appending a second signature or sending a digest for
 * bytes different from the signed body.
 */
export interface SignedRequestHeaders {
  /** Signature-Input built from the same frozen component list as the base. */ signatureInput: string;
  /** P1363 Signature header; sending a different byte form is refused by Anis. */ signature: string;
  /** UTC date covered by the signature, kept with the signature to prevent header drift. */ anisDate: string;
  /** Digest of the same body bytes that leave the process, so the gateway can compare it with what arrived. */ contentDigest?: string;
  /** Nonce repeated in the signature parameters so the gateway can detect replay and header mismatch. */ nonce?: string;
  /** Caller-owned operation UUID so retries refer to the same order rather than creating another identity. */ idempotencyKey?: string;
  /** Exact signed bytes for conformance diagnostics; never log them because they contain every covered request value. */ signatureBase: Uint8Array;
  /** Redacts signed values when Node recursively inspects this object. */
  [inspect.custom](): string;
}
