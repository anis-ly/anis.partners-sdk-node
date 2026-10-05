/**
 * The exact status, headers, and bytes received, plus the signature input sent with the request.
 *
 * @remarks The verifier hashes the received bytes directly and uses the client's own request signature input so a
 * response cannot claim a different request binding.
 */
export interface VerifiableResponse {
  /** HTTP status covered by the response signature. */
  status: number;
  /** Headers are matched case-insensitively because HTTP field names are case-insensitive. */
  headers: Readonly<Record<string, string>>;
  /** Exact response body bytes; decoding and re-encoding could hide a digest mismatch. */
  body: Uint8Array;
  /** Signature-Input sent on this request, when signed; the server's copy is not trusted as the client's request. */
  requestSignatureInput?: string;
}
