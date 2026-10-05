import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '../../src/errors/error-codes.generated.js';
import { parseEnrollmentKeyResult } from '../../src/models/enrollment.js';
import type { EnrollmentKeyResult } from '../../src/models/enrollment.js';
import { PARTNER_ROUTES } from '../../src/operations/partner-routes.js';
import { componentsOf, type SignatureProfile } from '../../src/signing/signature-profile.js';
import { renderErrorCodes } from '../../tools/generate-errors.mjs';

interface OpenApiOperation {
  'x-anis-route'?: { requestKind?: string };
}

interface OpenApiDocument {
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: { schemas: Record<string, { properties: Record<string, unknown> }> };
}

interface ErrorCatalogue {
  representations: { publicDocumentation: boolean; publicCode: string; retryable?: boolean }[];
}

type SameKeys<Left, Right> = Exclude<keyof Left, keyof Right> extends never
  ? Exclude<keyof Right, keyof Left> extends never
    ? true
    : false
  : false;
type Assert<T extends true> = T;
type PublishedEnrollmentAnswerKeys = 'keyId' | 'thumbprint' | 'safetyCode' | 'challenge' | 'challengeGeneration';

const openApi = JSON.parse(readFileSync(new URL('../../contracts/partner-public-v1.json', import.meta.url), 'utf8')) as OpenApiDocument;
const catalogue = JSON.parse(readFileSync(new URL('../../contracts/error-catalogue.json', import.meta.url), 'utf8')) as ErrorCatalogue;

describe('contract drift', () => {
  it('matches the published route table in both directions', () => {
    const published = Object.entries(openApi.paths).flatMap(([path, operations]) =>
      Object.keys(operations)
        .filter((method) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
        .map((method) => `${method.toUpperCase()} ${path}`),
    );
    const sdk = PARTNER_ROUTES.map((route) => `${route.method} ${route.template}`);

    expect(sdk.filter((route) => !published.includes(route))).toEqual([]);
    expect(published.filter((route) => !sdk.includes(route))).toEqual([]);
  });

  it('assigns every published route its declared signing profile', () => {
    for (const [path, operations] of Object.entries(openApi.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        const routeKind = operation['x-anis-route']?.requestKind;
        if (routeKind === undefined) {
          continue;
        }
        const expected: SignatureProfile | undefined =
          routeKind === 'safeRead'
            ? 'SafeRead'
            : routeKind === 'bodylessNonceMutation'
              ? 'BodylessNonceMutation'
              : routeKind === 'orderMutation'
                ? 'OrderMutation'
                : undefined;
        const actual = PARTNER_ROUTES.find((route) => route.method === method.toUpperCase() && route.template === path);

        if (actual === undefined) {
          throw new Error(`${method.toUpperCase()} ${path} must exist in the SDK route table.`);
        }
        const actualProfile = 'profile' in actual ? actual.profile : undefined;
        expect(actualProfile).toBe(expected);
      }
    }
  });

  it('recognizes every public error code in the catalogue', () => {
    const published = [
      ...new Set(
        catalogue.representations
          .filter((entry) => entry.publicDocumentation)
          .map((entry) => entry.publicCode)
      ),
    ].sort();

    expect([...ERROR_CODES].sort()).toEqual(published);
  });

  it('models exactly the published key submission answer members', () => {
    const published = Object.keys(openApi.components.schemas.EnrollmentKeyResult?.properties ?? {}).sort();
    const answer = parseEnrollmentKeyResult({
      keyId: '2f1c8a94-6d37-4e52-b8a1-0c9e5d3f7b26',
      thumbprint: 'thumbprint',
      safetyCode: '1234-5678-9ABC-DEFG',
      challenge: 'challenge',
      challengeGeneration: 1,
    });
    const exactTypeKeys: Assert<SameKeys<keyof EnrollmentKeyResult, PublishedEnrollmentAnswerKeys>> = true;
    const modelled = Object.keys(answer).sort();

    expect(modelled).toEqual(published);
    expect(modelled).toContain('safetyCode');
    expect(exactTypeKeys).toBe(true);
  });

  it('keeps the generated error source byte-for-byte aligned with the catalogue', () => {
    const generated = readFileSync(new URL('../../src/errors/error-codes.generated.ts', import.meta.url), 'utf8');

    expect(generated).toBe(renderErrorCodes(catalogue));
  });

  it('uses the three covered-component orders required by the contract', () => {
    expect(componentsOf('SafeRead')).toEqual(['@method', '@authority', '@path', '@query', 'x-anis-date']);
    expect(componentsOf('BodylessNonceMutation')).toEqual([
      '@method',
      '@authority',
      '@path',
      '@query',
      'content-digest',
      'nonce',
      'x-anis-date',
    ]);
    expect(componentsOf('OrderMutation')).toEqual([
      '@method',
      '@authority',
      '@path',
      '@query',
      'content-digest',
      'nonce',
      'idempotency-key',
      'x-anis-date',
    ]);
  });
});
