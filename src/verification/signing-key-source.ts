import type { SigningKeySet } from './partner-jwk.js';

/** Cancellation passed to signing-key retrieval during a caller's API operation. */
export interface SigningKeyRequestOptions {
  /** Stops waiting for or fetching a key document when the owning API call is canceled. */
  signal?: AbortSignal;
}

/** Supplies published keys separately from verification so key rotation stays out of signature-check logic. */
export interface SigningKeySource {
  /** Returns the cached key document or fetches it on first use. */
  get(options?: SigningKeyRequestOptions): Promise<SigningKeySet>;
  /** Fetches once after an unknown key so hostile key IDs cannot trigger unbounded requests. */
  refresh(options?: SigningKeyRequestOptions): Promise<SigningKeySet>;
}
