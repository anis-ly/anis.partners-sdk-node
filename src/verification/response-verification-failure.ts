/**
 * Closed set of reasons a signed response is discarded.
 *
 * @remarks A response that cannot be verified is never returned for use; stable reasons let a partner handle a
 * refusal without inspecting untrusted response content.
 */
export type ResponseVerificationFailure =
  | 'signature_missing'
  | 'signature_malformed'
  | 'signature_invalid'
  | 'content_digest_mismatch'
  | 'covered_components_mismatch'
  | 'unknown_key'
  | 'key_rejected'
  | 'algorithm_not_supported'
  | 'label_unexpected'
  | 'created_out_of_window';
