import { createHash } from 'node:crypto';

/**
 * Exact two-byte body used by the signature diagnostic.
 *
 * @remarks The diagnostic sends `{}` while reveal operations send zero bytes, so their covered digests must remain
 * distinct.
 */
export const EMPTY_OBJECT_BODY = new TextEncoder().encode('{}');

/**
 * Produces the RFC 9530 digest for the exact transmitted body bytes.
 *
 * @remarks Re-serializing after hashing changes the bytes the gateway receives and causes rejection before it reads
 * the request.
 */
export function contentDigestOf(bytes: Uint8Array): string {
  return `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`;
}
