import { describe, expect, it } from 'vitest';
import { decodeBase64Url } from '../../src/internal/base64url.js';

describe('base64url decoding', () => {
  it('rejects the standard alphabet, padding, empty values, and impossible lengths', () => {
    expect(decodeBase64Url('')).toBeUndefined();
    expect(decodeBase64Url('AA==')).toBeUndefined();
    expect(decodeBase64Url('+w')).toBeUndefined();
    expect(decodeBase64Url('A')).toBeUndefined();
  });

  it('rejects unused nonzero padding bits instead of accepting an alternate encoding', () => {
    expect(decodeBase64Url('AB')).toBeUndefined();
    expect(decodeBase64Url('AA')).toEqual(new Uint8Array([0]));
  });
});
