import type { ResponseVerificationFailure } from './response-verification-failure.js';

/**
 * Thrown when a response cannot be verified, so its content cannot be used.
 *
 * @remarks This is an exception rather than a flag on a result because callers must not accidentally act on an
 * unverified answer.
 */
export class UnverifiableResponseError extends Error {
  /** The contract reason for refusing the response, without requiring callers to parse message text. */
  readonly failure: ResponseVerificationFailure;
  /** Creates a response refusal while keeping its body, signature, base, and key material out of the message. */
  constructor(failure: ResponseVerificationFailure, detail: string) {
    super(`The Anis response could not be verified (${failure}): ${detail} Its content has been discarded.`);
    this.name = 'UnverifiableResponseError';
    this.failure = failure;
  }
}
