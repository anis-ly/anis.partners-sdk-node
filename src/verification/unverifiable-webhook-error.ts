import { AnisPartnersError } from '../errors/anis-partners-error.js';
import type { WebhookVerificationFailure } from './webhook-verification-failure.js';

/** Refuses untrusted webhook content without exposing its body, signature, or base. */
export class UnverifiableWebhookError extends AnisPartnersError {
  /** Stable contract reason, independent of human-readable message text. */
  readonly failure: WebhookVerificationFailure;

  /** Creates a refusal using only a non-secret explanation. */
  constructor(failure: WebhookVerificationFailure, detail: string) {
    super(`The Anis webhook could not be verified (${failure}): ${detail} Its content has been discarded.`);
    this.failure = failure;
  }
}
