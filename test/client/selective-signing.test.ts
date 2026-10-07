import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AnisPartnersClient } from '../../src/client.js';
import { validateClientOptions } from '../../src/client-options.js';
import { AnisEnrollmentClient } from '../../src/enrollment/enrollment-client.js';
import {
  AuthorizationError,
  DependencyUnavailableError,
  InvalidCredentialsError,
  RateLimitedError,
  ResourceNotFoundError,
} from '../../src/errors/anis-api-error.js';
import { Money } from '../../src/models/money.js';
import { PartnerTransport } from '../../src/operations/partner-transport.js';
import { KeyedSigner } from '../../src/signing/keyed-signer.js';
import type { SignatureProfile } from '../../src/signing/signature-profile.js';
import { UnverifiableResponseError } from '../../src/verification/unverifiable-response-error.js';

const uuid = '2f1c8a94-6d37-4e52-b8a1-0c9e5d3f7b26';
const signer = new KeyedSigner({ sign: () => Promise.resolve(new Uint8Array(64)) }, uuid);
const keyDocument = '/.well-known/partner-signing-keys.json';

/** The information reads Anis answers without a response signature. */
const unsignedReads: { route: string; profile?: SignatureProfile }[] = [
  { route: '/v1/profile', profile: 'SafeRead' },
  { route: '/v1/wallets', profile: 'SafeRead' },
  { route: '/v1/wallets/{walletId}', profile: 'SafeRead' },
  { route: '/v1/wallets/{walletId}/catalog/categories', profile: 'SafeRead' },
  { route: '/v1/wallets/{walletId}/catalog/categories/{categoryId}/subcategories', profile: 'SafeRead' },
  { route: '/v1/wallets/{walletId}/catalog/subcategories/{subcategoryId}', profile: 'SafeRead' },
  { route: '/v1/wallets/{walletId}/catalog/subcategories/{subcategoryId}/cards', profile: 'SafeRead' },
  { route: '/v1/wallets/{walletId}/cards', profile: 'SafeRead' },
  { route: '/v1/wallets/{walletId}/cards/{soldCardId}', profile: 'SafeRead' },
];

/** The routes whose every answer, success and refusal, Anis signs. */
const signedRoutes: { method: string; route: string; profile?: SignatureProfile }[] = [
  { method: 'POST', route: '/v1/wallets/{walletId}/orders', profile: 'OrderMutation' },
  { method: 'GET', route: '/v1/orders/{operationId}', profile: 'SafeRead' },
  { method: 'POST', route: '/v1/wallets/{walletId}/cards/{soldCardId}/reveal', profile: 'BodylessNonceMutation' },
  {
    method: 'POST',
    route: '/v1/wallets/{walletId}/invoices/{invoiceId}/cards/reveal',
    profile: 'BodylessNonceMutation',
  },
  { method: 'GET', route: '/v1/enrollments/{invitationId}' },
  { method: 'POST', route: '/v1/enrollments/{invitationId}/keys' },
  { method: 'POST', route: '/v1/enrollments/{invitationId}/proof' },
  { method: 'GET', route: '/v1/enrollments/{invitationId}/status' },
  { method: 'POST', route: '/v1/diagnostics/signature', profile: 'BodylessNonceMutation' },
];

/** Answers the way the gateway answers an information route: digest and request id, no signature. */
function unsignedFetchDouble(
  answer: (url: URL) => { status?: number; body?: string; headers?: Record<string, string> },
) {
  const paths: string[] = [];
  const fetcher = vi.fn<typeof globalThis.fetch>((resource) => {
    const url = new URL(typeof resource === 'string' || resource instanceof URL ? resource : resource.url);
    paths.push(url.pathname);
    const configured = answer(url);
    const body = new TextEncoder().encode(configured.body ?? '{}');
    const headers = new Headers(configured.headers);
    headers.set('Content-Digest', `sha-256=:${createHash('sha256').update(body).digest('base64')}:`);
    headers.set('X-Request-Id', 'req-unsigned-001');
    headers.set('Content-Type', 'application/json');
    return Promise.resolve(new Response(body, { status: configured.status ?? 200, headers }));
  });
  return { fetcher, paths };
}

function client(fetch: typeof globalThis.fetch) {
  return AnisPartnersClient.create({ options: { authority: 'https://partners.example' }, signer, fetch });
}

function transport(fetcher: typeof globalThis.fetch, keysRead: () => void = () => undefined) {
  return new PartnerTransport({
    ...validateClientOptions({ authority: 'https://partners.example' }),
    signer,
    fetcher,
    keySource: {
      get: () => {
        keysRead();
        return Promise.resolve({ keys: [] });
      },
      refresh: () => Promise.resolve({ keys: [] }),
    },
  });
}

function concrete(template: string): string {
  return template.replace(/\{[A-Za-z]+\}/g, uuid);
}

describe('selective response signing', () => {
  it.each(unsignedReads)('reads $route without verifying or fetching signing keys', async ({ route, profile }) => {
    const fake = unsignedFetchDouble(() => ({ body: '{"items":[]}' }));
    const keysRead = vi.fn();

    const result = await transport(fake.fetcher, keysRead).send({
      method: 'GET',
      route,
      path: concrete(route),
      ...(profile === undefined ? {} : { profile }),
    });

    expect(new TextDecoder().decode(result.body)).toBe('{"items":[]}');
    expect(keysRead).not.toHaveBeenCalled();
    const sent = new Headers(fake.fetcher.mock.calls[0]?.[1]?.headers);
    expect(sent.has('Signature')).toBe(true);
    expect(sent.has('Signature-Input')).toBe(true);
  });

  it.each(signedRoutes)(
    'refuses an unsigned answer on the signed route $method $route as signature_missing',
    async ({ method, route, profile }) => {
      const fake = unsignedFetchDouble(() => ({ body: '{}' }));

      await expect(
        transport(fake.fetcher).send({
          method,
          route,
          path: concrete(route),
          ...(profile === undefined ? {} : { profile }),
          ...(profile === 'OrderMutation' ? { operationId: uuid, body: new TextEncoder().encode('{}') } : {}),
        }),
      ).rejects.toMatchObject({ name: 'UnverifiableResponseError', failure: 'signature_missing' });
    },
  );

  it('returns every information read from the client when its answer is unsigned', async () => {
    const wallet = `{"id":"${uuid}","name":"Main","currency":"LYD","balance":{"amount":"1.000","currency":"LYD"}}`;
    const item = `{"id":"${uuid}"}`;
    const fake = unsignedFetchDouble((url) => {
      const path = url.pathname;
      if (path === '/v1/profile') return { body: `{"partner":{"id":"${uuid}"}}` };
      if (path === '/v1/wallets') return { body: `{"items":[${wallet}]}` };
      if (path === `/v1/wallets/${uuid}`) return { body: wallet };
      if (path.endsWith(`/catalog/subcategories/${uuid}`)) return { body: item };
      if (path === `/v1/wallets/${uuid}/cards/${uuid}`) return { body: item };
      return { body: `{"items":[${item}]}` };
    });
    const api = client(fake.fetcher);

    expect((await api.profile.get()).partner?.id).toBe(uuid);
    expect((await api.wallets.listPage()).items[0]?.id).toBe(uuid);
    expect((await api.wallets.get(uuid)).balance.amount).toBe('1.000');
    expect((await api.catalogue.listCategoriesPage(uuid)).items[0]?.id).toBe(uuid);
    expect((await api.catalogue.listSubcategoriesPage(uuid, uuid)).items[0]?.id).toBe(uuid);
    expect((await api.catalogue.getSubcategory(uuid, uuid)).id).toBe(uuid);
    expect((await api.catalogue.listCardsPage(uuid, uuid)).items[0]?.id).toBe(uuid);
    expect((await api.ownedCards.listPage(uuid)).items[0]?.id).toBe(uuid);
    expect((await api.ownedCards.get(uuid, uuid)).id).toBe(uuid);

    expect(fake.paths).toHaveLength(9);
    expect(fake.paths).not.toContain(keyDocument);
  });

  it('ignores a signature an information read carries unexpectedly, even one that would not verify', async () => {
    const fake = unsignedFetchDouble(() => ({
      body: `{"partner":{"id":"${uuid}"}}`,
      headers: { 'Signature-Input': 'sig1=("@status");created=1;keyid="unknown"', Signature: 'sig1=:AAAA:' },
    }));

    const profile = await client(fake.fetcher).profile.get();

    expect(profile.partner?.id).toBe(uuid);
    expect(fake.paths).toEqual(['/v1/profile']);
  });

  it.each([
    [401, 'invalid_credentials', InvalidCredentialsError, () => client(unsigned).profile.get()],
    [403, 'insufficient_scope', AuthorizationError, () => client(unsigned).catalogue.listCategoriesPage(uuid)],
    [404, 'wallet_not_granted', ResourceNotFoundError, () => client(unsigned).wallets.get(uuid)],
    [429, 'rate_limited', RateLimitedError, () => client(unsigned).ownedCards.get(uuid, uuid)],
    [503, 'dependency_unavailable', DependencyUnavailableError, () => client(unsigned).wallets.listPage()],
  ] as const)(
    'maps an unsigned %i %s refusal on an information read to its typed error',
    async (status, code, type, call) => {
      refusal = { status, code };

      const error = await call().catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(type);
      expect(error).toMatchObject({
        code,
        status,
        requestId: 'req-unsigned-001',
        ...(status === 429 ? { retryAfter: 7 } : {}),
      });
      expect(error).not.toBeInstanceOf(UnverifiableResponseError);
    },
  );

  it('still refuses an unsigned refusal on a signed route instead of trusting its code', async () => {
    const fake = unsignedFetchDouble(() => ({
      status: 503,
      body: '{"status":503,"code":"dependency_unavailable","requestId":"req-unsigned-001"}',
    }));

    await expect(client(fake.fetcher).orders.get(uuid)).rejects.toMatchObject({
      name: 'UnverifiableResponseError',
      failure: 'signature_missing',
    });
  });

  it('treats an unsigned order answer as an unknown outcome, never as completed', async () => {
    const fake = unsignedFetchDouble(() => ({ status: 201, body: `{"operationId":"${uuid}","status":"completed"}` }));
    const unitPrice = Money.of('1.000', 'LYD');

    const result = await client(fake.fetcher).orders.create(uuid, uuid, {
      cardId: uuid,
      quantity: 1,
      expectedUnitPrice: unitPrice,
      expectedTotal: unitPrice,
    });

    expect(result.kind).toBe('unknown');
    expect(result).toMatchObject({ cause: { failure: 'signature_missing' } });
  });

  it.each([
    ['reveal', () => client(unsignedSuccess).ownedCards.reveal(uuid, uuid)],
    ['invoice reveal', () => client(unsignedSuccess).ownedCards.revealInvoice(uuid, uuid)],
    ['signature self-test', () => client(unsignedSuccess).diagnostics.checkSignature()],
  ] as const)('refuses an unsigned %s answer through the client', async (_, call) => {
    await expect(call()).rejects.toMatchObject({ failure: 'signature_missing' });
  });

  it.each([
    ['read', (enrollment: AnisEnrollmentClient) => enrollment.get()],
    ['status read', (enrollment: AnisEnrollmentClient) => enrollment.getStatus()],
  ] as const)('refuses an unsigned enrollment %s answer', async (_, call) => {
    const fake = unsignedFetchDouble(() => ({ body: `{"invitationId":"${uuid}","state":"pendingProof"}` }));
    const enrollment = AnisEnrollmentClient.create({
      authority: 'https://partners.example',
      invitationId: uuid,
      enrollmentToken: 'enrollment-token',
      fetch: fake.fetcher,
    });

    await expect(call(enrollment)).rejects.toMatchObject({ failure: 'signature_missing' });
  });
});

let refusal: { status: number; code: string } = { status: 500, code: 'internal_error' };
const unsigned: typeof globalThis.fetch = (resource, init) =>
  unsignedFetchDouble(() => ({
    status: refusal.status,
    body: JSON.stringify({ status: refusal.status, code: refusal.code, requestId: 'req-unsigned-001' }),
    ...(refusal.status === 429 ? { headers: { 'Retry-After': '7' } } : {}),
  })).fetcher(resource, init);
const unsignedSuccess: typeof globalThis.fetch = (resource, init) =>
  unsignedFetchDouble(() => ({ body: `{"id":"${uuid}","items":[]}` })).fetcher(resource, init);
