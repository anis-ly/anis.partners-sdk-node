import { describe, expect, it } from 'vitest';
import { AnisPartnersClient } from '../../src/client.js';
import { InsufficientBalanceError, RateLimitedError } from '../../src/errors/anis-api-error.js';
import { Money } from '../../src/models/money.js';
import { KeyedSigner } from '../../src/signing/keyed-signer.js';
import { signedFetchDouble } from '../support/signed-fetch.js';

const walletId = '2f1c8a94-6d37-4e52-b8a1-0c9e5d3f7b26';
const operationId = 'b26bf827-8484-44aa-987a-b033e4cfa401';
const cardId = '8d4b1e73-9a25-4c60-8f37-6b2e9d5a1c48';
const soldCardId = '6e5b2d70-4416-4a6e-900a-5528803a6a7d';
const signer = new KeyedSigner({ sign: () => Promise.resolve(new Uint8Array(64)) }, operationId);
const order = {
  cardId,
  quantity: 1,
  expectedUnitPrice: Money.of('10.500', 'LYD'),
  expectedTotal: Money.of('10.500', 'LYD'),
};
const clientFor = (fetcher: typeof globalThis.fetch) =>
  AnisPartnersClient.create({ options: { authority: 'https://partners.example' }, signer, fetch: fetcher });

describe('order outcomes', () => {
  it('returns a completed result with credentials from a successful answer', async () => {
    const fake = await signedFetchDouble(() => ({
      status: 201,
      body: `{"operationId":"${operationId}","status":"completed","soldCards":[{"soldCardId":"${soldCardId}","voucher":"one-time"}]}`,
    }));

    const result = await clientFor(fake.fetcher).orders.create(walletId, operationId, order);

    expect(result).toMatchObject({ kind: 'completed', credentials: [{ voucher: 'one-time' }], codesWithheld: false });
  });

  it('returns delivered credentials when every host logger call throws', async () => {
    const fake = await signedFetchDouble(() => ({
      status: 201,
      body: `{"operationId":"${operationId}","status":"completed","soldCards":[{"soldCardId":"${soldCardId}","voucher":"delivered-code"}]}`,
    }));
    const fail = () => {
      throw new Error('logger unavailable');
    };
    const client = AnisPartnersClient.create({
      options: { authority: 'https://partners.example' },
      signer,
      fetch: fake.fetcher,
      logger: { debug: fail, info: fail, warn: fail, error: fail },
    });

    const result = await client.orders.create(walletId, operationId, order);

    expect(result).toMatchObject({ kind: 'completed', credentials: [{ voucher: 'delivered-code' }] });
  });

  it('classifies repeated true replay headers on a successful answer', async () => {
    const fake = await signedFetchDouble(() => ({
      status: 201,
      headers: [
        ['Idempotency-Replayed', 'true'],
        ['Idempotency-Replayed', 'true'],
      ],
      body: `{"operationId":"${operationId}","status":"completed","invoiceId":"${soldCardId}"}`,
    }));

    const result = await clientFor(fake.fetcher).orders.create(walletId, operationId, order);

    expect(result).toMatchObject({ kind: 'replayed', order: { invoiceId: soldCardId } });
  });

  it('closes a refusal carrying repeated true replay headers', async () => {
    const fake = await signedFetchDouble(() => ({
      status: 409,
      headers: [
        ['Idempotency-Replayed', 'true'],
        ['Idempotency-Replayed', 'true'],
      ],
      body: '{"status":409,"code":"insufficient_balance"}',
    }));

    const result = await clientFor(fake.fetcher).orders.create(walletId, operationId, order);

    expect(result).toMatchObject({ kind: 'notPlaced', refusal: { isReplayed: true } });
  });

  it('marks withheld completions even when credentials appear in the body', async () => {
    const fake = await signedFetchDouble(() => ({
      status: 201,
      body: `{"operationId":"${operationId}","status":"completed","externalReference":"INV-77","codesWithheld":true,"soldCards":[{"soldCardId":"${soldCardId}"}]}`,
    }));

    const result = await clientFor(fake.fetcher).orders.create(walletId, operationId, order);

    expect(result).toMatchObject({ kind: 'completed', codesWithheld: true, order: { externalReference: 'INV-77' } });
  });

  it('treats a credential-free first completion as withheld', async () => {
    const fake = await signedFetchDouble(() => ({
      status: 201,
      body: `{"operationId":"${operationId}","status":"completed"}`,
    }));

    const result = await clientFor(fake.fetcher).orders.create(walletId, operationId, order);

    expect(result).toMatchObject({ kind: 'completed', credentials: [], codesWithheld: true });
  });

  it('returns replayed without credentials when Anis marks an answer as already delivered', async () => {
    const fake = await signedFetchDouble(() => ({
      status: 201,
      headers: { 'Idempotency-Replayed': 'true' },
      body: `{"operationId":"${operationId}","status":"completed","invoiceId":"${soldCardId}"}`,
    }));

    const result = await clientFor(fake.fetcher).orders.create(walletId, operationId, order);

    expect(result).toMatchObject({ kind: 'replayed', order: { invoiceId: soldCardId } });
  });

  it('returns recovered credentials even when the resume answer is marked replayed', async () => {
    const fake = await signedFetchDouble(() => ({
      status: 200,
      headers: { 'Idempotency-Replayed': 'true' },
      body: `{"operationId":"${operationId}","status":"completed","soldCards":[{"soldCardId":"${soldCardId}","voucher":"recovered"}]}`,
    }));

    const result = await clientFor(fake.fetcher).orders.resume(walletId, operationId, order);

    expect(result).toMatchObject({ kind: 'completed', credentials: [{ voucher: 'recovered' }] });
  });

  it('returns a closed typed refusal for a final price decision', async () => {
    const fake = await signedFetchDouble(() => ({
      status: 409,
      body: '{"status":409,"code":"insufficient_balance","title":"Insufficient balance"}',
    }));

    const result = await clientFor(fake.fetcher).orders.create(walletId, operationId, order);

    expect(result.kind).toBe('notPlaced');
    if (result.kind !== 'notPlaced') throw new TypeError('Expected a closed refusal.');
    expect(result.refusal).toBeInstanceOf(InsufficientBalanceError);
    expect(result.refusal.isReplayed).toBe(false);
  });

  it('keeps a rate-limited order open for the signed retry delay', async () => {
    const fake = await signedFetchDouble(() => ({
      status: 429,
      headers: { 'Retry-After': '14' },
      body: '{"status":429,"code":"rate_limited"}',
    }));

    const result = await clientFor(fake.fetcher).orders.create(walletId, operationId, order);

    expect(result.kind).toBe('unknown');
    if (result.kind !== 'unknown') throw new TypeError('Expected an unresolved order.');
    expect(result.suggestedDelayMs).toBe(14000);
    expect(result.cause).toBeInstanceOf(RateLimitedError);
  });

  it('uses a default retry delay when a rate refusal omits Retry-After', async () => {
    const fake = await signedFetchDouble(() => ({ status: 429, body: '{"status":429,"code":"rate_limited"}' }));

    const result = await clientFor(fake.fetcher).orders.create(walletId, operationId, order);

    expect(result).toMatchObject({ kind: 'unknown', suggestedDelayMs: 5000 });
  });

  it('keeps a new refusal unresolved when resuming an earlier unknown order', async () => {
    const fake = await signedFetchDouble(() => ({
      status: 409,
      body: '{"status":409,"code":"insufficient_balance"}',
    }));

    const result = await clientFor(fake.fetcher).orders.resume(walletId, operationId, order);

    expect(result).toMatchObject({ kind: 'unknown', suggestedDelayMs: 5000 });
  });

  it('uses a minute before retrying a refusal at the authorization door', async () => {
    const fake = await signedFetchDouble(() => ({
      status: 401,
      body: '{"status":401,"code":"invalid_credentials"}',
    }));

    const result = await clientFor(fake.fetcher).orders.create(walletId, operationId, order);

    expect(result).toMatchObject({ kind: 'unknown', suggestedDelayMs: 60000 });
  });

  it('uses the signed Retry-After value for an authorization-door refusal', async () => {
    const fake = await signedFetchDouble(() => ({
      status: 403,
      headers: { 'Retry-After': '30' },
      body: '{"status":403,"code":"insufficient_scope"}',
    }));

    const result = await clientFor(fake.fetcher).orders.create(walletId, operationId, order);

    expect(result).toMatchObject({ kind: 'unknown', suggestedDelayMs: 30000 });
  });

  it('uses the authorization-door delay when resuming an unresolved order', async () => {
    const fake = await signedFetchDouble(() => ({
      status: 401,
      body: '{"status":401,"code":"invalid_credentials"}',
    }));

    const result = await clientFor(fake.fetcher).orders.resume(walletId, operationId, order);

    expect(result).toMatchObject({ kind: 'unknown', suggestedDelayMs: 60000 });
  });

  it('closes an authorization-door refusal that Anis marks replayed', async () => {
    const fake = await signedFetchDouble(() => ({
      status: 401,
      headers: { 'Idempotency-Replayed': 'true' },
      body: '{"status":401,"code":"invalid_credentials"}',
    }));

    const result = await clientFor(fake.fetcher).orders.create(walletId, operationId, order);

    expect(result).toMatchObject({ kind: 'notPlaced', refusal: { isReplayed: true } });
  });

  it('closes a replayed refusal without counting it as an unknown outcome', async () => {
    const fake = await signedFetchDouble(() => ({
      status: 409,
      headers: { 'Idempotency-Replayed': 'true' },
      body: '{"status":409,"code":"insufficient_balance"}',
    }));

    const result = await clientFor(fake.fetcher).orders.resume(walletId, operationId, order);

    expect(result).toMatchObject({ kind: 'notPlaced', refusal: { isReplayed: true, orderOutcome: 'notPlaced' } });
  });

  it('keeps a dependency refusal unresolved for a later resume', async () => {
    const fake = await signedFetchDouble(() => ({
      status: 503,
      body: '{"status":503,"code":"dependency_unavailable"}',
    }));

    const result = await clientFor(fake.fetcher).orders.create(walletId, operationId, order);

    expect(result).toMatchObject({
      kind: 'unknown',
      suggestedDelayMs: 5000,
      cause: { code: 'dependency_unavailable' },
    });
  });

  it('keeps a connection failure unresolved on both create and resume', async () => {
    const client = clientFor(() => Promise.reject(new Error('connection unavailable')));

    const created = await client.orders.create(walletId, operationId, order);
    const resumed = await client.orders.resume(walletId, operationId, order);

    expect(created).toMatchObject({ kind: 'unknown', suggestedDelayMs: 5000 });
    expect(resumed).toMatchObject({ kind: 'unknown', suggestedDelayMs: 5000 });
  });

  it('keeps a timed-out order unresolved on both create and resume', async () => {
    const client = AnisPartnersClient.create({
      options: { authority: 'https://partners.example', timeoutMs: 5 },
      signer,
      fetch: (_resource, init = {}) =>
        new Promise((_resolve, reject) => {
          const signal = init.signal;
          if (signal == null) {
            reject(new Error('timeout signal was not supplied'));
            return;
          }
          signal.addEventListener(
            'abort',
            () => {
              const reason: unknown = signal.reason;
              reject(reason instanceof Error ? reason : new Error('Request timed out.'));
            },
            { once: true },
          );
        }),
    });

    const created = await client.orders.create(walletId, operationId, order);
    const resumed = await client.orders.resume(walletId, operationId, order);

    expect(created).toMatchObject({ kind: 'unknown', suggestedDelayMs: 5000 });
    expect(resumed).toMatchObject({ kind: 'unknown', suggestedDelayMs: 5000 });
  });

  it('keeps a verified success with invalid order JSON unresolved', async () => {
    const fake = await signedFetchDouble(() => ({ status: 201, body: '{' }));

    const result = await clientFor(fake.fetcher).orders.create(walletId, operationId, order);

    expect(result.kind).toBe('unknown');
    if (result.kind !== 'unknown') throw new TypeError('Expected an unresolved order.');
    expect(result.suggestedDelayMs).toBe(5000);
    expect(result.cause).toBeInstanceOf(SyntaxError);
  });

  it('keeps a verified successful order with an empty body unresolved', async () => {
    const fake = await signedFetchDouble(() => ({ status: 201, body: 'null' }));

    const result = await clientFor(fake.fetcher).orders.create(walletId, operationId, order);

    expect(result).toMatchObject({
      kind: 'unknown',
      cause: { code: 'internal_error', problem: { title: 'Empty body' } },
    });
  });

  it('keeps an unverified successful order answer unknown', async () => {
    const fake = await signedFetchDouble(() => ({
      status: 201,
      body: `{"operationId":"${operationId}","status":"completed"}`,
    }));
    const fetcher: typeof globalThis.fetch = async (resource, init) => {
      const response = await fake.fetcher(resource, init);
      const bytes = new Uint8Array(await response.arrayBuffer());
      bytes[0] = bytes[0] === 123 ? 91 : 123;
      return new Response(bytes, { status: response.status, headers: response.headers });
    };

    const result = await clientFor(fetcher).orders.create(walletId, operationId, order);

    expect(result.kind).toBe('unknown');
  });

  it('rethrows a caller cancellation after recording an unknown result', async () => {
    const controller = new AbortController();
    const stop = new Error('partner stopped waiting');
    const client = AnisPartnersClient.create({
      options: { authority: 'https://partners.example' },
      signer,
      fetch: (_resource, init = {}) =>
        Promise.reject(init.signal?.reason instanceof Error ? init.signal.reason : new Error('aborted')),
    });
    controller.abort(stop);

    await expect(client.orders.create(walletId, operationId, order, { signal: controller.signal })).rejects.toBe(stop);
  });
});
