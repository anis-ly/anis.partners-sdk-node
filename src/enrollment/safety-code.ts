import { decodeBase64Url } from '../internal/base64url.js';
import { fixedTimeEqual } from '../internal/bytes.js';

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** @internal Converts a local thumbprint into the code read to Anis staff. */
export function safetyCodeFromThumbprint(thumbprint: string): string {
  const bytes = decodeBase64Url(thumbprint);
  if (bytes?.length !== 32) throw new TypeError('A thumbprint must encode 32 bytes.');
  let buffer = 0;
  let bits = 0;
  let code = '';
  for (const value of bytes.subarray(0, 10)) {
    buffer = (buffer << 8) | value;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      code += alphabet.charAt((buffer >> bits) & 31);
    }
    buffer &= (1 << bits) - 1;
  }
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}-${code.slice(12)}`;
}

/** @internal Compares a caller-entered safety code or complete thumbprint. */
export function safetyCodeMatches(entered: string | null | undefined, thumbprint: string): boolean {
  const raw = (entered ?? '').trim();
  const candidate = raw.replace(/[ -]/g, '').toUpperCase().replaceAll('O', '0').replace(/[IL]/g, '1');
  const expected = candidate.length === 16 ? safetyCodeFromThumbprint(thumbprint).replaceAll('-', '') : thumbprint;
  return fixedTimeEqual(
    new TextEncoder().encode(candidate.length === 16 ? candidate : raw),
    new TextEncoder().encode(expected),
  );
}
