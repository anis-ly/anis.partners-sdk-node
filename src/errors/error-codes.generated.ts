// This file is generated from contracts/error-catalogue.json by tools/generate-errors.mjs.
// Do not edit it directly; run npm run generate:errors.

/** Every published error code this SDK version recognizes. */
export const ERROR_CODES = [
  'account_inactive',
  'allowed_debt_consent_required',
  'binding_not_authorized',
  'business_subscription_required',
  'card_not_found',
  'card_unavailable',
  'challenge_expired',
  'currency_not_supported',
  'daily_limit_exceeded',
  'dependency_unavailable',
  'idempotency_conflict',
  'insufficient_balance',
  'insufficient_scope',
  'internal_error',
  'invalid_content_digest',
  'invalid_credentials',
  'invitation_invalid',
  'invoice_reveal_limit_exceeded',
  'key_duplicate',
  'key_proof_invalid',
  'malformed_signed_request',
  'operation_processing',
  'owner_limit_exceeded',
  'price_changed',
  'purchase_not_allowed',
  'quantity_unavailable',
  'rate_limited',
  'replay_detected',
  'request_timeout',
  'resource_not_found',
  'reveal_not_allowed',
  'signature_expired',
  'source_ip_not_allowed',
  'validation_failed',
  'wallet_disabled',
  'wallet_expired',
  'wallet_not_granted',
] as const;

/** A published error code, or unknown when Anis adds one this SDK has not seen yet. */
export type ErrorCode = (typeof ERROR_CODES)[number] | 'unknown';

/** Codes the public catalogue marks as retryable. Unknown codes are never assumed to be retryable. */
export const RETRYABLE_ERROR_CODES: ReadonlySet<ErrorCode> = new Set([
  'dependency_unavailable',
  'internal_error',
  'operation_processing',
  'rate_limited',
  'replay_detected',
  'request_timeout',
  'signature_expired',
]);

/** Resolves a wire code, retaining forward compatibility when Anis publishes a new code. */
export function parseErrorCode(code: string | null | undefined): ErrorCode {
  if (code === null || code === undefined) {
    return 'unknown';
  }
  return ERROR_CODES.find((known) => known === code) ?? 'unknown';
}
