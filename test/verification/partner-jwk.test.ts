import { describe, expect, it } from 'vitest';
import { parseSigningKeySet } from '../../src/verification/partner-jwk.js';

describe('published signing key documents', () => {
  it('treats a null private scalar as absent', () => {
    const parsed = parseSigningKeySet('{"keys":[{"kty":"EC","crv":"P-256","x":"x","y":"y","d":null}]}');

    expect(parsed.keys[0]).not.toHaveProperty('d');
  });

  it.each(['kty', 'crv', 'x', 'y', 'kid', 'use', 'alg', 'd'] as const)(
    'rejects signing key member %s with the wrong JSON type',
    (member) => {
      expect(() => parseSigningKeySet(JSON.stringify({ keys: [{ [member]: 7 }] }))).toThrow(
        `The signing-key member "${member}" must be a string`,
      );
    },
  );

  it('rejects a non-object entry in the signing key array', () => {
    expect(() => parseSigningKeySet('{"keys":[null]}')).toThrow('Every signing key must be a JSON object');
  });
});
