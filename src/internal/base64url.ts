/**
 * Encodes bytes using RFC 4648 base64url without padding.
 *
 * @remarks Padding and the standard Base64 alphabet are not accepted for nonces, coordinates, thumbprints, or proofs.
 */
export function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/**
 * Decodes only strict unpadded base64url strings.
 *
 * @remarks Returning no value for padding or non-url characters keeps wire values in the single form Anis verifies.
 */
export function decodeBase64Url(value: string | null | undefined): Uint8Array | undefined {
  if (!value || value.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.toString('base64url') === value ? new Uint8Array(decoded) : undefined;
  } catch {
    return undefined;
  }
}
