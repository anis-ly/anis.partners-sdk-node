import { describe, expect, it } from 'vitest';
import { retryAfterSeconds } from '../../src/internal/retry-after.js';

describe('Retry-After parsing', () => {
  it('accepts zero seconds', () => {
    expect(retryAfterSeconds('0')).toBe(0);
  });

  it('accepts the signed 32-bit maximum seconds', () => {
    expect(retryAfterSeconds('2147483647')).toBe(2_147_483_647);
  });

  it('rejects seconds above the signed 32-bit maximum', () => {
    expect(retryAfterSeconds('2147483648')).toBeUndefined();
  });
});
