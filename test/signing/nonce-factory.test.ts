import { describe, expect, it } from 'vitest';
import { decodeBase64Url } from '../../src/internal/base64url.js';
import { RandomNonceFactory } from '../../src/signing/nonce-factory.js';

describe('random mutation nonces', () => {
  it('creates independent nonces containing sixteen random bytes', () => {
    const factory = new RandomNonceFactory();
    const first = factory.create();
    const second = factory.create();

    expect(decodeBase64Url(first)).toHaveLength(16);
    expect(decodeBase64Url(second)).toHaveLength(16);
    expect(second).not.toBe(first);
  });
});
