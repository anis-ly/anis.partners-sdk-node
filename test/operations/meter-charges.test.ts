import { describe, expect, it, vi } from 'vitest';
import { AnisApiError, IdempotencyConflictError } from '../../src/errors/anis-api-error.js';
import { MalformedResponseError } from '../../src/errors/malformed-response-error.js';
import { RequestSigningError } from '../../src/signing/request-signing-error.js';
import { Money } from '../../src/models/money.js';
import { AnisPartnersClient } from '../../src/client.js';
import { signedFetchDouble } from '../support/signed-fetch.js';
import { listFixture, publicFixture } from '../models/product-fixtures.js';
import {
  accepted,
  clientFor,
  collect,
  meterId,
  meterIntent,
  meterPackage,
  packageId,
  signer,
  walletId,
} from './product-test-support.js';

describe('meter charges', () => {
  it('omits list options so the server applies the default window and page size', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response(JSON.stringify({ items: [], nextCursor: null }))),
    );
    const api = clientFor(fetch).meterCharges;
    const page = await api.getMeterChargesPage(walletId);
    expect(page).toEqual({ items: [], nextCursor: null });
    expect(await collect(api.getMeterCharges(walletId))).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetch.mock.calls) {
      expect(url).toEqual(new URL(`https://partners.example/v1/wallets/${walletId}/meter-charges`));
      expect(init?.method).toBe('GET');
      expect(init?.body).toBeUndefined();
    }
  });
  it.each([
    { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-10-03T00:00:00Z') },
    { from: new Date('2026-10-03T00:00:00Z'), to: new Date('2026-10-01T00:00:00Z') },
    { pageSize: 0 },
    { pageSize: 101 },
    { pageSize: 1.5 },
  ])('surfaces unsigned server validation for invalid list options %j', async (options) => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            type: 'https://developers.anis.ly/errors/validation-failed',
            title: 'Invalid filters',
            status: 422,
            code: 'validation_failed',
            extensions: { fields: { window: 'Maximum 31 days' } },
          }),
          { status: 422, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );
    await expect(clientFor(fetch).meterCharges.getMeterChargesPage(walletId, options)).rejects.toMatchObject({
      code: 'validation_failed',
      status: 422,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const resource = fetch.mock.calls[0]?.[0];
    if (resource === undefined) throw new Error('Missing captured request.');
    const sent = new URL(typeof resource === 'string' || resource instanceof URL ? resource : resource.url);
    if (options.from !== undefined) {
      expect(sent.searchParams.get('from')).toBe(options.from.toISOString());
      expect(sent.searchParams.get('to')).toBe(options.to.toISOString());
    } else expect(sent.searchParams.get('pageSize')).toBe(String(options.pageSize));
  });

  it('reads wallet packages with absent businessPrice and follows cursors', async () => {
    const fake = await signedFetchDouble((url) => ({
      body: JSON.stringify({ items: [meterPackage], nextCursor: url.search ? null : 'next+/=&' }),
    }));
    const client = clientFor(fake.fetcher);
    const rows = await collect(client.meterCharges.getMeterPackages(walletId));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.unitPrice.amount).toBe('97.500');
    expect(rows[0]).not.toHaveProperty('businessPrice');
    expect(fake.requests[1]?.url.searchParams.get('cursor')).toBe('next+/=&');
    expect(fake.requests.every((request) => request.body.length === 0)).toBe(true);
  });
  it('stops a package walk when Anis repeats a continuation cursor', async () => {
    const fake = await signedFetchDouble(() => ({
      body: JSON.stringify({ items: [meterPackage], nextCursor: 'same' }),
    }));
    await expect(collect(clientFor(fake.fetcher).meterCharges.getMeterPackages(walletId))).rejects.toBeInstanceOf(
      MalformedResponseError,
    );
    expect(fake.requests).toHaveLength(2);
  });
  it('creates then resumes the exact intent and id with fresh nonces and signed delay/location', async () => {
    const fake = await signedFetchDouble(() => ({
      status: 202,
      body: JSON.stringify(accepted('meterCharge', meterId)),
      headers: { Location: `/v1/meter-charges/${meterId}`, 'Retry-After': '7' },
    }));
    const client = clientFor(fake.fetcher);
    const intent = {
      ...meterIntent,
      expectedTotal: Money.of('97.500', 'LYD', new Date('2026-10-20T00:00:00Z')),
      operationId: 'must-not-send',
    };
    for (const call of [
      client.meterCharges.create.bind(client.meterCharges),
      client.meterCharges.resume.bind(client.meterCharges),
    ])
      expect(await call(walletId.toUpperCase(), meterId.toUpperCase(), intent)).toMatchObject({
        kind: 'processing',
        operationId: meterId,
        accepted: accepted('meterCharge', meterId),
        suggestedDelayMs: 7000,
        location: `/v1/meter-charges/${meterId}`,
      });
    expect(fake.requests[0]?.body).toEqual(fake.requests[1]?.body);
    expect(JSON.parse(new TextDecoder().decode(fake.requests[0]?.body))).toEqual({
      packageId,
      meterNumber: '0268000710262',
      expectedTotal: { amount: '97.500', currency: 'LYD' },
      externalReference: meterIntent.externalReference,
    });
    const headers = fake.requests.map((request) => new Headers(request.init.headers));
    expect(headers.map((header) => header.get('Idempotency-Key'))).toEqual([meterId, meterId]);
    expect(headers[0]?.get('Nonce')).not.toBe(headers[1]?.get('Nonce'));
  });
  it('keeps meter operation unresolved after a timeout', async () => {
    const fetcher: typeof globalThis.fetch = (_resource, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener(
          'abort',
          () => {
            const reason: unknown = signal.reason;
            reject(reason instanceof Error ? reason : new Error('Timed out'));
          },
          { once: true },
        );
      });
    const client = clientFor(fetcher, 5);
    expect(await client.meterCharges.create(walletId, meterId, meterIntent)).toMatchObject({
      kind: 'unknown',
      operationId: meterId,
      suggestedDelayMs: 5000,
    });
    expect(await client.meterCharges.resume(walletId, meterId, meterIntent)).toMatchObject({
      kind: 'unknown',
      operationId: meterId,
    });
  });
  it('keeps a verified gateway idempotency conflict unknown on create and resume without replacing the saved intent', async () => {
    const fake = await signedFetchDouble(() => ({
      status: 409,
      body: '{"status":409,"code":"idempotency_conflict"}',
    }));
    const client = clientFor(fake.fetcher);
    for (const result of [
      await client.meterCharges.create(walletId, meterId, meterIntent),
      await client.meterCharges.resume(walletId, meterId, meterIntent),
    ]) {
      expect(result).toMatchObject({ kind: 'unknown', operationId: meterId, suggestedDelayMs: 5000 });
      if (result.kind !== 'unknown') throw new Error('Expected an unresolved conflict.');
      expect(result.cause).toBeInstanceOf(IdempotencyConflictError);
    }
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[0]?.body).toEqual(fake.requests[1]?.body);
    expect(fake.requests.every((request) => new Headers(request.init.headers).get('Idempotency-Key') === meterId)).toBe(
      true,
    );
  });
  it.each([
    [409, 'insufficient_balance'],
    [422, 'meter_rejected'],
    [409, 'idempotency_conflict'],
  ] as const)('raises the recorded %i %s refusal on a signed read with the replayed flag', async (status, code) => {
    const fake = await signedFetchDouble(() => ({
      status,
      body: JSON.stringify({ status, code }),
      headers: { 'Idempotency-Replayed': 'true' },
    }));
    const error: unknown = await clientFor(fake.fetcher)
      .meterCharges.get(meterId)
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(AnisApiError);
    expect(error).toMatchObject({ code, status, isReplayed: true });
    expect(fake.requests.every((request) => request.init.method === 'GET')).toBe(true);
  });
  it.each([
    'meter_rejected',
    'package_unavailable',
    'insufficient_balance',
    'price_changed',
    'spending_limit_exceeded',
  ])('closes definitive %s on create and recorded replay but leaves fresh resume unresolved', async (code) => {
    let replayed = false;
    const fake = await signedFetchDouble(() => ({
      status: 409,
      body: JSON.stringify({ code, status: 409 }),
      ...(replayed ? { headers: { 'Idempotency-Replayed': 'true' } } : {}),
    }));
    const client = clientFor(fake.fetcher);
    expect(await client.meterCharges.create(walletId, meterId, meterIntent)).toMatchObject({
      kind: 'notPlaced',
      refusal: { code },
    });
    expect(await client.meterCharges.resume(walletId, meterId, meterIntent)).toMatchObject({ kind: 'unknown' });
    replayed = true;
    expect(await client.meterCharges.resume(walletId, meterId, meterIntent)).toMatchObject({
      kind: 'notPlaced',
      refusal: { code, isReplayed: true },
    });
  });
  it.each([
    'invalid_credentials',
    'signature_expired',
    'insufficient_scope',
    'wallet_not_granted',
    'malformed_signed_request',
  ])('keeps door refusal %s unresolved for a minute', async (code) => {
    const fake = await signedFetchDouble(() => ({ status: 403, body: JSON.stringify({ status: 403, code }) }));
    const client = clientFor(fake.fetcher);
    for (const call of [
      client.meterCharges.create.bind(client.meterCharges),
      client.meterCharges.resume.bind(client.meterCharges),
    ])
      expect(await call(walletId, meterId, meterIntent)).toMatchObject({
        kind: 'unknown',
        operationId: meterId,
        suggestedDelayMs: 60000,
      });
  });
  it.each(['dependency_unavailable', 'request_timeout', 'internal_error', 'future_error'])(
    'never closes an uncertain %s refusal even if marked replayed',
    async (code) => {
      const fake = await signedFetchDouble(() => ({
        status: 503,
        body: JSON.stringify({ status: 503, code }),
        headers: { 'Idempotency-Replayed': 'true', 'Retry-After': '0' },
      }));
      expect(await clientFor(fake.fetcher).meterCharges.resume(walletId, meterId, meterIntent)).toMatchObject({
        kind: 'unknown',
        suggestedDelayMs: 0,
      });
    },
  );
  it.each(['', '{', 'null', '{}'])('keeps an unreadable or incomplete response unresolved: %s', async (body) => {
    const fake = await signedFetchDouble(() => ({ status: 202, body }));
    expect(await clientFor(fake.fetcher).meterCharges.create(walletId, meterId, meterIntent)).toMatchObject({
      kind: 'unknown',
      operationId: meterId,
      cause: expect.any(MalformedResponseError) as unknown,
    });
  });
  it.each([
    { ...accepted('meterCharge', meterId), extra: 1 },
    { ...accepted('meterCharge', meterId), operationType: 'directRecharge' },
    { ...accepted('meterCharge', meterId), operationId: walletId },
  ])('rejects a malformed 202 response %j', async (wire) => {
    const fake = await signedFetchDouble(() => ({ status: 202, body: JSON.stringify(wire) }));
    expect(await clientFor(fake.fetcher).meterCharges.create(walletId, meterId, meterIntent)).toMatchObject({
      kind: 'unknown',
      cause: expect.any(MalformedResponseError) as unknown,
    });
  });
  it.each([
    ['meter-succeeded', 'final'],
    ['meter-failed-refunded', 'final'],
    ['meter-failed-not-charged', 'final'],
    ['meter-failed-pending', 'processing'],
  ] as const)('classifies current owner %s as %s', async (name, kind) => {
    const fake = await signedFetchDouble(() => ({ body: JSON.stringify(publicFixture(name)) }));
    const result = await clientFor(fake.fetcher).meterCharges.resume(walletId, meterId, meterIntent);
    expect(result).toMatchObject({ kind, meterCharge: { operationId: meterId } });
  });
  it('keeps a failed charge with its refund pending open and carries the read, but closes refunded and notCharged', async () => {
    const fake = await signedFetchDouble(() => ({ body: JSON.stringify(publicFixture('meter-failed-pending')) }));
    const open = await clientFor(fake.fetcher).meterCharges.resume(walletId, meterId, meterIntent);
    expect(open).toMatchObject({
      kind: 'processing',
      meterCharge: { status: 'failed', refund: { status: 'pending', amount: { amount: '97.500', currency: 'LYD' } } },
    });
    for (const [name, status] of [
      ['meter-failed-refunded', 'refunded'],
      ['meter-failed-not-charged', 'notCharged'],
    ] as const) {
      const closed = await signedFetchDouble(() => ({ body: JSON.stringify(publicFixture(name)) }));
      expect(await clientFor(closed.fetcher).meterCharges.resume(walletId, meterId, meterIntent)).toMatchObject({
        kind: 'final',
        meterCharge: { status: 'failed', refund: { status } },
      });
    }
  });
  it('reads a failed charge with its refund pending through get as a normal 200 read', async () => {
    const fake = await signedFetchDouble(() => ({ body: JSON.stringify(publicFixture('meter-failed-pending')) }));
    expect(await clientFor(fake.fetcher).meterCharges.get(meterId)).toMatchObject({
      status: 'failed',
      refund: { status: 'pending', amount: { amount: '97.500', currency: 'LYD' } },
    });
  });
  it('keeps a future owner status unresolved', async () => {
    const fake = await signedFetchDouble(() => ({
      body: JSON.stringify({ ...publicFixture('meter-succeeded'), status: 'future' }),
    }));
    expect(await clientFor(fake.fetcher).meterCharges.create(walletId, meterId, meterIntent)).toMatchObject({
      kind: 'processing',
      meterCharge: { status: 'unknown' },
    });
  });
  it('dispatches GET 202 to the strict accepted parser and GET 200 to full owner state', async () => {
    let projected = false;
    const fake = await signedFetchDouble(() => ({
      status: projected ? 200 : 202,
      body: JSON.stringify(projected ? publicFixture('meter-succeeded') : accepted('meterCharge', meterId)),
    }));
    const client = clientFor(fake.fetcher);
    expect(await client.meterCharges.get(meterId)).toEqual(accepted('meterCharge', meterId));
    projected = true;
    expect(await client.meterCharges.get(meterId)).toMatchObject({
      status: 'succeeded',
      receipt: { tokens: [{ label: 'KCT1' }, { label: 'KCT2' }, { label: 'STS' }] },
    });
    expect(fake.requests.every((request) => request.init.method === 'GET' && request.body.length === 0)).toBe(true);
  });
  it('rejects mismatched operation ids on signed reads', async () => {
    const fake = await signedFetchDouble(() => ({
      body: JSON.stringify({ ...publicFixture('meter-succeeded'), operationId: walletId }),
    }));
    await expect(clientFor(fake.fetcher).meterCharges.get(meterId)).rejects.toBeInstanceOf(MalformedResponseError);
  });
  it('pages charge summaries while preserving raw filters and opaque cursors', async () => {
    const from = new Date('2026-10-01T00:00:00Z');
    const to = new Date('2026-10-20T00:00:00Z');
    const fake = await signedFetchDouble((url) => ({
      body: JSON.stringify({
        ...listFixture('meter-charges'),
        nextCursor: url.searchParams.has('cursor') ? null : '+/=& عربي',
      }),
    }));
    const rows = await collect(
      clientFor(fake.fetcher).meterCharges.getMeterCharges(walletId, {
        status: 'succeeded',
        meterNumber: '0268000710262',
        from,
        to,
        pageSize: 50,
      }),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).not.toHaveProperty('receipt');
    for (const request of fake.requests)
      expect(Object.fromEntries(request.url.searchParams)).toMatchObject({
        status: 'succeeded',
        meterNumber: '0268000710262',
        from: from.toISOString(),
        to: to.toISOString(),
        pageSize: '50',
      });
    expect(fake.requests[1]?.url.searchParams.get('cursor')).toBe('+/=& عربي');
  });
  it('does not send malformed local requests or reclassify pre-send signer failures', async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>();
    const client = clientFor(fetcher);
    await expect(client.meterCharges.create('bad', meterId, meterIntent)).rejects.toThrow(TypeError);
    await expect(
      client.meterCharges.create(walletId, meterId, { ...meterIntent, expectedTotal: Money.of('0', 'LYD') }),
    ).rejects.toThrow(RangeError);
    const stop = new Error('Signer unavailable');
    const broken = AnisPartnersClient.create({
      options: { authority: 'https://partners.example' },
      signer: { keyId: signer.keyId, sign: () => Promise.reject(stop) },
      fetch: fetcher,
    });
    await expect(broken.meterCharges.create(walletId, meterId, meterIntent)).rejects.toBeInstanceOf(
      RequestSigningError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('records unknown then rethrows caller cancellation', async () => {
    const controller = new AbortController();
    const stop = new Error('Stopped');
    controller.abort(stop);
    const log = vi.fn();
    const client = AnisPartnersClient.create({
      options: { authority: 'https://partners.example' },
      signer,
      logger: { warn: log },
      fetch: (_resource, init) =>
        Promise.reject(init?.signal?.reason instanceof Error ? init.signal.reason : new Error('Aborted')),
    });
    await expect(
      client.meterCharges.create(walletId, meterId, meterIntent, { signal: controller.signal }),
    ).rejects.toBe(stop);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('outcome unknown'),
      expect.objectContaining({ operationId: meterId, reason: 'canceled' }),
    );
  });
});
