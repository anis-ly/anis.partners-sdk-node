import { describe, expect, it } from 'vitest';
import { keyThumbprint } from '../../src/enrollment/key-thumbprint.js';
import { safetyCodeFromThumbprint, safetyCodeMatches } from '../../src/enrollment/safety-code.js';
import type { PartnerJwk } from '../../src/verification/partner-jwk.js';
import { readFileSync } from 'node:fs';
import { readVector, vectorFiles, vectorId } from '../support/vectors.js';

interface SafetyVector {
  id: string;
  publicJwk: PartnerJwk;
  thumbprint: string;
  expectedCode: string;
  inputs: { case: string; entered: string; matches: boolean }[];
}
const files = vectorFiles('safety-code', 'SC-');
const manifest = JSON.parse(readFileSync('test/vectors/safety-code/manifest.json', 'utf8')) as {
  total: number;
  vectors: { id: string; inputs: number; accepted: number }[];
};

describe('safety-code vectors', () => {
  it('contains all four safety-code vectors', () => {
    expect(files).toHaveLength(4);
    expect(manifest.total).toBe(files.length);
    expect(manifest.vectors.map((vector) => vector.id)).toEqual(files.map(vectorId));
  });
  it('checks each safety-code vector input count against the manifest', () => {
    for (const path of files) {
      const vector = readVector(path, (value) => value as SafetyVector);
      const declared = manifest.vectors.find((entry) => entry.id === vector.id);
      expect(declared, `${vector.id} is declared in the manifest`).toBeDefined();
      expect(vector.inputs).toHaveLength(declared?.inputs ?? -1);
      expect(vector.inputs.filter((input) => input.matches)).toHaveLength(declared?.accepted ?? -1);
    }
  });
  it('requires a complete thumbprint before producing a safety code', () => {
    expect(() => safetyCodeFromThumbprint('not-a-thumbprint')).toThrow(TypeError);
  });
  it.each(files.map((path) => ({ path, id: vectorId(path) })))(
    '$id computes the declared local thumbprint and code',
    ({ path }) => {
      const vector = readVector(path, (value) => value as SafetyVector);
      const thumbprint = keyThumbprint(vector.publicJwk);
      expect(thumbprint).toBe(vector.thumbprint);
      expect(safetyCodeFromThumbprint(thumbprint)).toBe(vector.expectedCode);
    },
  );
  it.each(
    files.flatMap((path) => {
      const vector = readVector(path, (value) => value as SafetyVector);
      return vector.inputs.map((input) => ({
        id: `${vector.id} ${input.case}`,
        thumbprint: vector.thumbprint,
        ...input,
      }));
    }),
  )('$id matches as declared', ({ entered, thumbprint, matches }) => {
    expect(safetyCodeMatches(entered, thumbprint)).toBe(matches);
  });
});
