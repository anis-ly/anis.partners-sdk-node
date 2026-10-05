/** Response component and its exact value, rebuilt locally so the response cannot omit a protected field. */
export interface ResponseComponent {
  /** Lower-case name or pseudo-header required by RFC 9421. */
  name: string;
  /** Value received from the response and covered by the signature. */
  value: string;
  /** Whether the field is bound to the request that this client actually sent. */
  requestBound: boolean;
}

/**
 * Rebuilds the frozen response component profile before checking a signature.
 *
 * @remarks The advertised component list is not trusted: rebuilding from received fields ensures the body digest and
 * request binding remain covered even if a response tries to omit them.
 */
export const PartnerResponseSignatureBase = {
  /** Response signatures are accepted within this whole-second window to match the gateway's freshness calculation. */ MAX_AGE_SECONDS: 60,
  /** The sole response label; disagreement between headers is refused. */ label: 'sig1',
  /** The only supported algorithm; there is no weaker fallback for responses. */ algorithm: 'ecdsa-p256-sha256',

  /** Derives covered fields from what actually arrived so absent optional values are never signed as empty fields. */
  components(
    status: number,
    digest: string,
    requestId: string,
    requestSignatureInput?: string,
    location?: string,
    retryAfter?: string,
    replayed?: string,
    cacheControl?: string,
  ): ResponseComponent[] {
    const result: ResponseComponent[] = [
      { name: '@status', value: String(status), requestBound: false },
      { name: 'content-digest', value: digest, requestBound: false },
      { name: 'x-request-id', value: requestId, requestBound: false },
    ];
    if (requestSignatureInput)
      result.push({ name: 'signature-input', value: requestSignatureInput, requestBound: true });
    for (const [name, value] of [
      ['location', location],
      ['retry-after', retryAfter],
      ['idempotency-replayed', replayed],
      ['cache-control', cacheControl],
    ] as const)
      if (value) result.push({ name, value, requestBound: false });
    return result;
  },

  /** Builds exact UTF-8 bytes; request binding and its `;req` identifier must agree in both places. */
  build(components: readonly ResponseComponent[], created: number, keyId: string): Uint8Array {
    const params = `(${components.map((part) => `"${part.name}"${part.requestBound ? ';req' : ''}`).join(' ')});created=${String(created)};keyid="${keyId}";alg="${PartnerResponseSignatureBase.algorithm}"`;
    const lines = components.map((part) => `"${part.name}"${part.requestBound ? ';req' : ''}: ${part.value}\n`);
    lines.push(`"@signature-params": ${params}`);
    return new TextEncoder().encode(lines.join(''));
  },
};
