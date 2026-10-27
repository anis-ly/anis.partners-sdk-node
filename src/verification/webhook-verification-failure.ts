/** Exhaustive webhook refusal vocabulary, independent of response verification policy. */
export const WEBHOOK_VERIFICATION_FAILURES = [
  'signature_missing',
  'signature_malformed',
  'signature_invalid',
  'content_digest_mismatch',
  'covered_components_mismatch',
  'unknown_key',
  'key_rejected',
  'algorithm_not_supported',
  'label_unexpected',
  'created_out_of_window',
  'profile_unexpected',
  'key_compromised',
  'key_retired',
  'key_not_yet_valid',
  'signature_expired',
  'validity_window_invalid',
  'target_uri_mismatch',
  'application_id_mismatch',
  'key_purpose_mismatch',
  'method_unexpected',
  'event_id_mismatch',
  'envelope_invalid',
] as const;

/** Stable reason an incoming webhook cannot be trusted. */
export type WebhookVerificationFailure = (typeof WEBHOOK_VERIFICATION_FAILURES)[number];
