/**
 * Validates a UUID and returns its canonical lower-case D form.
 *
 * @remarks Request `keyid` and operation identity have one wire spelling; canonicalizing once prevents the base and
 * emitted headers from describing different requests.
 */
export function canonicalUuid(value: string): string {
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value)) {
    throw new TypeError('A canonical UUID is required.');
  }
  return value.toLowerCase();
}
