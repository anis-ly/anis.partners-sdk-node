import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '../../src/errors/error-codes.generated.js';
import { parseEnrollmentKeyResult } from '../../src/models/enrollment.js';
import type { EnrollmentKeyResult } from '../../src/models/enrollment.js';
import { PARTNER_ROUTES } from '../../src/operations/partner-routes.js';
import { componentsOf, type SignatureProfile } from '../../src/signing/signature-profile.js';
import { renderErrorCodes } from '../../tools/generate-errors.mjs';

interface OpenApiOperation {
  'x-anis-availability'?: string;
  description?: string;
  responses?: Record<string, {
    headers?: Record<string, unknown>;
    content?: Record<string, { schema?: { $ref?: string } }>;
  }>;
  'x-anis-route'?: {
    requestKind?: string;
    signsResponse?: boolean;
    routeId?: string;
    requiredScope?: string;
    walletBound?: boolean;
  };
}

interface OpenApiDocument {
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: { schemas: Record<string, { properties: Record<string, unknown>; required?: string[] }> };
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

/**
 * Gateway routes that exist only on the staging test environment, where a partner may list, add and remove its
 * own allowed source addresses. The owner ruled that they are never part of the SDK, so every drift comparison
 * excludes exactly these three and no other route.
 */
const STAGING_TEST_ONLY_ROUTES: readonly string[] = [
  'GET /v1/application/networks',
  'POST /v1/application/networks',
  'POST /v1/application/networks/remove',
];
const isSdkRoute = (method: string, path: string) => !STAGING_TEST_ONLY_ROUTES.includes(`${method.toUpperCase()} ${path}`);

describe('contract drift', () => {
  it('pins the final owner contract bytes', () => {
    for (const [file, expected] of [
      ['partner-public-v1.json', '1eb3aeaf583cf3c0d1cd01b68e697e241ced5995a002d61cf26e11325ad106e0'],
      ['error-catalogue.json', '4048623c5c72688fe7debc4ac62d6294025f2e28403ad29f5e7716e8b2050229'],
    ] as const)
      expect(createHash('sha256').update(readFileSync(new URL(`../../contracts/${file}`, import.meta.url))).digest('hex'))
        .toBe(expected);
  });
  it('pins all 42 gateway routes and 21 signed answers before the exact staging-only exclusion', () => {
    const published = Object.entries(openApi.paths).flatMap(([path, operations]) =>
      Object.entries(operations).filter(([method]) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
        .map(([method, operation]) => ({ route: `${method.toUpperCase()} ${path}`, signed: operation['x-anis-route']?.signsResponse })),
    );
    expect(published).toHaveLength(42);
    expect(published.filter((entry) => entry.signed)).toHaveLength(21);
    expect(published.filter((entry) => !entry.signed)).toHaveLength(21);
    const sdk = PARTNER_ROUTES.map((entry) => `${entry.method} ${entry.template}`);
    expect(published.filter((entry) => !sdk.includes(entry.route)).map((entry) => entry.route).sort())
      .toEqual([...STAGING_TEST_ONLY_ROUTES].sort());
  });

  it('retains the 22 baseline routes and adds exactly 17 product routes', () => {
    expect(PARTNER_ROUTES).toHaveLength(39);
    expect(PARTNER_ROUTES.filter((route) => route.signedResponse)).toHaveLength(19);
    expect(PARTNER_ROUTES.filter((route) => !route.signedResponse)).toHaveLength(20);
  });

  it('pins new scopes, wallet binding and stable ids to the published gateway design table', () => {
        const expected = JSON.parse(readFileSync(new URL('./product-route-fixtures.json', import.meta.url), 'utf8')) as {
      method: string; template: string; scope: string | null; walletBound: boolean; routeId: string;
    }[];
    expect(expected).toHaveLength(17);
    expect(new Set(expected.map((route) => route.routeId)).size).toBe(17);
    for (const row of expected) {
      const actual = PARTNER_ROUTES.find((route) => route.method === row.method && route.template === row.template);
      expect(actual).toMatchObject(row);
    }
  });
  it('matches the published route id, scope and wallet binding of every product route', () => {
    for (const row of PARTNER_ROUTES.filter((route) => 'routeId' in route)) {
      const published = openApi.paths[row.template]?.[row.method.toLowerCase()]?.['x-anis-route'];
      expect(published, `${row.method} ${row.template}`).toBeDefined();
      expect(published?.routeId).toBe(row.routeId);
      expect(published?.requiredScope ?? null).toBe(row.scope);
      expect(published?.walletBound).toBe(row.walletBound);
    }
  });

  it('matches the published route table in both directions', () => {
    const published = Object.entries(openApi.paths).flatMap(([path, operations]) =>
      Object.keys(operations)
        .filter((method) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
        .map((method) => `${method.toUpperCase()} ${path}`)
        .filter((route) => !STAGING_TEST_ONLY_ROUTES.includes(route)),
    );
    const sdk = PARTNER_ROUTES.map((route) => `${route.method} ${route.template}`);

    expect(sdk.filter((route) => !published.includes(route))).toEqual([]);
    expect(published.filter((route) => !sdk.includes(route))).toEqual([]);
  });

  it('keeps the staging-only routes out of the SDK route table', () => {
    for (const route of STAGING_TEST_ONLY_ROUTES)
      expect(PARTNER_ROUTES.map((entry) => `${entry.method} ${entry.template}`)).not.toContain(route);
    expect(STAGING_TEST_ONLY_ROUTES.every((route) => Object.keys(openApi.paths).includes(route.split(' ')[1] ?? ''))).toBe(
      true,
    );
  });

  it('pins the exact three staging-only network operations to the owner availability marker', () => {
    const marked = Object.entries(openApi.paths).flatMap(([path, operations]) =>
      Object.entries(operations).filter(([, operation]) => operation['x-anis-availability'] === 'staging-only')
        .map(([method]) => `${method.toUpperCase()} ${path}`),
    );
    expect(marked.sort()).toEqual([...STAGING_TEST_ONLY_ROUTES].sort());
    for (const entry of STAGING_TEST_ONLY_ROUTES) {
      const [method, path] = entry.split(' ');
      const operation = openApi.paths[path ?? '']?.[method?.toLowerCase() ?? ''];
      expect(operation?.description).toContain('Staging only — testing endpoints, not available in production');
      expect(operation?.description).toContain('غير متاحة في الإنتاج');
    }
  });
  it('keeps published key purpose optional while retaining both explicit purposes', () => {
    const schema = openApi.components.schemas.PublishedSigningKey;
    expect(schema?.required).not.toContain('purpose');
    expect(schema?.properties.purpose).toMatchObject({ type: 'string', enum: ['answer', 'webhook'] });
    expect(schema?.properties.purpose).toHaveProperty('description', expect.stringContaining('always emits it'));
  });
  it('publishes the strict recipient processing acknowledgement and signed Location', () => {
    const operation = openApi.paths['/v1/direct-recharges/{operationId}/recipient']?.patch;
    expect(operation?.['x-anis-route']?.signsResponse).toBe(true);
    expect(Object.keys(operation?.responses ?? {}).filter((status) => /^2\d\d$/.test(status))).toEqual(['202']);
    expect(operation?.responses).not.toHaveProperty('200');
    expect(operation?.description).toContain('Location header points to /v1/direct-recharges/{operationId}');
    expect(operation?.responses?.['202']?.headers).toHaveProperty('Location');
    expect(operation?.responses?.['202']?.content?.['application/json']?.schema?.$ref)
      .toBe('#/components/schemas/DirectRechargeAccepted');
    const schema = openApi.components.schemas.DirectRechargeAccepted;
    expect([...(schema?.required ?? [])].sort()).toEqual(['operationId', 'operationType', 'status']);
    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual(['operationId', 'operationType', 'status']);
  });

  it('assigns every published route its declared signing profile', () => {
    for (const [path, operations] of Object.entries(openApi.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        if (!isSdkRoute(method, path)) continue;
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

  it('declares for every published route whether its answers are signed', () => {
    for (const [path, operations] of Object.entries(openApi.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        if (!isSdkRoute(method, path)) continue;
        const declared = operation['x-anis-route']?.signsResponse;
        const actual = PARTNER_ROUTES.find((route) => route.method === method.toUpperCase() && route.template === path);

        expect(declared, `${method.toUpperCase()} ${path} must declare signsResponse`).toBeTypeOf('boolean');
        expect(actual?.signedResponse, `${method.toUpperCase()} ${path}`).toBe(declared);
      }
    }
  });

  it('signs exactly the answers that move money, deliver card codes or establish a key', () => {
    const signed = PARTNER_ROUTES.filter((route) => route.signedResponse).map((route) => `${route.method} ${route.template}`);
    const unsigned = PARTNER_ROUTES.filter((route) => !route.signedResponse).map(
      (route) => `${route.method} ${route.template}`,
    );

    expect(signed.sort()).toEqual(
      [
        'POST /v1/wallets/{walletId}/meter-charges',
        'GET /v1/meter-charges/{operationId}',
        'POST /v1/wallets/{walletId}/direct-recharges',
        'GET /v1/direct-recharges/{operationId}',
        'PATCH /v1/direct-recharges/{operationId}/recipient',
        'PUT /v1/webhook-endpoint',
        'POST /v1/webhook-endpoint/test',
        'POST /v1/webhook-events/{eventId}/redeliver',
        'POST /v1/application/suspend',
        'POST /v1/keys/{keyId}/revoke',
        'POST /v1/wallets/{walletId}/orders',
        'GET /v1/orders/{operationId}',
        'POST /v1/wallets/{walletId}/owned-cards/{soldCardId}/reveal',
        'POST /v1/wallets/{walletId}/invoices/{invoiceId}/owned-cards/reveal',
        'GET /v1/enrollments/{invitationId}',
        'POST /v1/enrollments/{invitationId}/keys',
        'POST /v1/enrollments/{invitationId}/proof',
        'GET /v1/enrollments/{invitationId}/status',
        'POST /v1/diagnostics/signature',
      ].sort(),
    );
    expect(unsigned.sort()).toEqual(
      [
        'GET /v1/wallets/{walletId}/catalog/cards/{cardId}',
        'GET /v1/wallets/{walletId}/meter-packages',
        'GET /v1/wallets/{walletId}/meter-charges',
        'GET /v1/wallets/{walletId}/direct-recharge-products',
        'GET /v1/wallets/{walletId}/direct-recharge-products/{productId}',
        'GET /v1/wallets/{walletId}/direct-recharge-products/{productId}/locations',
        'GET /v1/wallets/{walletId}/direct-recharge-products/{productId}/quote',
        'GET /v1/wallets/{walletId}/direct-recharges',
        'GET /v1/webhook-endpoint',
        'GET /v1/webhook-events',
        'GET /v1/profile',
        'GET /v1/wallets',
        'GET /v1/wallets/{walletId}',
        'GET /v1/wallets/{walletId}/catalog/categories',
        'GET /v1/wallets/{walletId}/catalog/categories/{categoryId}/subcategories',
        'GET /v1/wallets/{walletId}/catalog/subcategories/{subcategoryId}',
        'GET /v1/wallets/{walletId}/catalog/subcategories/{subcategoryId}/cards',
        'GET /v1/wallets/{walletId}/owned-cards',
        'GET /v1/wallets/{walletId}/owned-cards/{soldCardId}',
        'GET /.well-known/partner-signing-keys.json',
      ].sort(),
    );
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
