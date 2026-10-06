import { describe, expect, it } from 'vitest';
import { canonicalUuid } from '../../src/internal/uuid.js';

describe('UUID canonicalisation', () => {
  it('names the value that failed UUID validation', () => {
    expect(() => canonicalUuid('not-a-uuid', 'walletId')).toThrow('walletId must be a canonical UUID.');
  });
});
