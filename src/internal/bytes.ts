import { timingSafeEqual } from 'node:crypto';

/** Compares byte strings without stopping at the first differing byte. */
export function fixedTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Copies bytes into an ArrayBuffer accepted by WebCrypto's strict DOM typings. */
export function arrayBufferOf(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
