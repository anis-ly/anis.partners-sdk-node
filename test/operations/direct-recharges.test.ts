import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { AnisApiError, IdempotencyConflictError, ValidationFailedError } from '../../src/errors/anis-api-error.js';
import type { DirectRechargeProcessing } from '../../src/operations/product-results.js';
import { Money } from '../../src/models/money.js';
import { MalformedResponseError } from '../../src/errors/malformed-response-error.js';
import { signedFetchDouble } from '../support/signed-fetch.js';
import { publicFixture, listFixture } from '../models/product-fixtures.js';
import {
  accepted,
  clientFor,
  collect,
  productId,
  rechargeId,
  rechargeIntent,
  walletId,
} from './product-test-support.js';

describe('direct recharges', () => {
  it('returns a signed recipient processing acknowledgement without replaying the correction', async () => {
    const fake = await signedFetchDouble(() => ({
      status: 202,
      body: JSON.stringify(accepted('directRecharge', rechargeId)),
      headers: { Location: `/v1/direct-recharges/${rechargeId}` },
    }));
    expect(
      await clientFor(fake.fetcher).directRecharges.updateRecipient(rechargeId, {
        recipient: rechargeIntent.recipient,
      }),
    ).toEqual({
      kind: 'processing',
      operationId: rechargeId,
      suggestedDelayMs: 5000,
      location: `/v1/direct-recharges/${rechargeId}`,
      accepted: accepted('directRecharge', rechargeId),
    });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.init.method).toBe('PATCH');
    expect(new Headers(fake.requests[0]?.init.headers).get('Idempotency-Key')).toBeNull();
  });
  it('honors Retry-After as the suggested delay of a recipient correction', async () => {
    const fake = await signedFetchDouble(() => ({
      status: 202,
      body: JSON.stringify(accepted('directRecharge', rechargeId)),
      headers: { Location: `/v1/direct-recharges/${rechargeId}`, 'Retry-After': '7' },
    }));
    const corrected = await clientFor(fake.fetcher).directRecharges.updateRecipient(rechargeId, {
      recipient: rechargeIntent.recipient,
    });
    expect(corrected.suggestedDelayMs).toBe(7000);
  });
  it('returns the same processing result type as a 202 create, with the verified Location', async () => {
    const location = `/v1/direct-recharges/${rechargeId}`;
    const fake = await signedFetchDouble(() => ({
      status: 202,
      body: JSON.stringify(accepted('directRecharge', rechargeId)),
      headers: { Location: location },
    }));
    const api = clientFor(fake.fetcher).directRecharges;
    const created = await api.create(walletId, rechargeId, rechargeIntent);
    if (created.kind !== 'processing' || !created.accepted) throw new Error('Expected the create acknowledgement.');
    const corrected = await api.updateRecipient(rechargeId, { recipient: rechargeIntent.recipient });
    expectTypeOf(corrected).toEqualTypeOf<DirectRechargeProcessing>();
    expect(corrected).toEqual(created);
    expect(corrected).toEqual({
      kind: 'processing',
      operationId: rechargeId,
      suggestedDelayMs: 5000,
      location,
      accepted: created.accepted,
    });
    expect(Object.keys(corrected).sort()).toEqual(['accepted', 'kind', 'location', 'operationId', 'suggestedDelayMs']);
    expect(fake.requests.map((request) => request.init.method)).toEqual(['POST', 'PATCH']);
  });
  it.each([
    { ...accepted('directRecharge', rechargeId), operationId: walletId },
    { ...accepted('directRecharge', rechargeId), recipient: [] },
    { ...accepted('directRecharge', rechargeId), location: `/v1/direct-recharges/${rechargeId}` },
    { ...accepted('directRecharge', rechargeId), operationType: 'meterCharge' },
    { ...accepted('directRecharge', rechargeId), status: 'completed' },
    { operationId: rechargeId, status: 'processing' },
  ])('rejects a malformed signed recipient processing acknowledgement %j', async (body) => {
    const fake = await signedFetchDouble(() => ({
      status: 202,
      body: JSON.stringify(body),
      headers: { Location: `/v1/direct-recharges/${rechargeId}` },
    }));
    await expect(
      clientFor(fake.fetcher).directRecharges.updateRecipient(rechargeId, { recipient: [] }),
    ).rejects.toBeInstanceOf(MalformedResponseError);
    expect(fake.requests).toHaveLength(1);
  });
  it('accepts a matching absolute Location on the configured HTTPS authority', async () => {
    const location = `https://partners.example/v1/direct-recharges/${rechargeId}`;
    const fake = await signedFetchDouble(() => ({
      status: 202,
      body: JSON.stringify(accepted('directRecharge', rechargeId)),
      headers: { Location: location },
    }));
    expect(
      await clientFor(fake.fetcher).directRecharges.updateRecipient(rechargeId.toUpperCase(), { recipient: [] }),
    ).toEqual({
      kind: 'processing',
      operationId: rechargeId,
      suggestedDelayMs: 5000,
      location,
      accepted: accepted('directRecharge', rechargeId),
    });
    expect(fake.requests).toHaveLength(1);
  });
  it.each([
    undefined,
    '',
    `/v1/direct-recharges/${walletId}`,
    `/v1/direct-recharges/${rechargeId}/recipient`,
    `v1/direct-recharges/${rechargeId}`,
    `//partners.example/v1/direct-recharges/${rechargeId}`,
    `https://attacker.example/v1/direct-recharges/${rechargeId}`,
    `http://partners.example/v1/direct-recharges/${rechargeId}`,
    `https://partners.example:8443/v1/direct-recharges/${rechargeId}`,
    `https://user@partners.example/v1/direct-recharges/${rechargeId}`,
    `/v1/direct-recharges/${rechargeId}?extra=1`,
    `/v1/direct-recharges/${rechargeId}#fragment`,
    `/v1/unused/../direct-recharges/${rechargeId}`,
    `/v1/direct-recharges/%2f${rechargeId}`,
    'not a URI',
  ])('rejects a signed recipient acknowledgement with missing or invalid Location %s', async (location) => {
    const fake = await signedFetchDouble(() => ({
      status: 202,
      body: JSON.stringify(accepted('directRecharge', rechargeId)),
      ...(location === undefined ? {} : { headers: { Location: location } }),
    }));
    const result = clientFor(fake.fetcher).directRecharges.updateRecipient(rechargeId, { recipient: [] });
    if (location === '') await expect(result).rejects.toMatchObject({ failure: 'covered_components_mismatch' });
    else await expect(result).rejects.toBeInstanceOf(MalformedResponseError);
    expect(fake.requests).toHaveLength(1);
  });
  it.each([
    { status: 200, body: publicFixture('circle-suspended-after-recipient-fix') },
    { status: 200, body: accepted('directRecharge', rechargeId) },
    { status: 201, body: accepted('directRecharge', rechargeId) },
    { status: 202, body: publicFixture('circle-suspended-after-recipient-fix') },
  ])('rejects recipient success outside the 202 acknowledgement contract: %j', async ({ status, body }) => {
    const fake = await signedFetchDouble(() => ({
      status,
      body: JSON.stringify(body),
      headers: { Location: `/v1/direct-recharges/${rechargeId}` },
    }));
    await expect(
      clientFor(fake.fetcher).directRecharges.updateRecipient(rechargeId, { recipient: [] }),
    ).rejects.toBeInstanceOf(MalformedResponseError);
    expect(fake.requests).toHaveLength(1);
  });
  it('rejects a Location changed after signing without following it', async () => {
    const fake = await signedFetchDouble(() => ({
      status: 202,
      body: JSON.stringify(accepted('directRecharge', rechargeId)),
      headers: { Location: `/v1/direct-recharges/${rechargeId}` },
    }));
    const fetcher: typeof globalThis.fetch = async (resource, init) => {
      const response = await fake.fetcher(resource, init);
      const url = new URL(typeof resource === 'string' || resource instanceof URL ? resource : resource.url);
      if (url.pathname.startsWith('/.well-known/')) return response;
      const headers = new Headers(response.headers);
      headers.set('Location', `/v1/direct-recharges/${walletId}`);
      return new Response(await response.arrayBuffer(), { status: response.status, headers });
    };
    await expect(
      clientFor(fetcher).directRecharges.updateRecipient(rechargeId, { recipient: [] }),
    ).rejects.toMatchObject({ failure: 'signature_invalid' });
    expect(fake.requests).toHaveLength(1);
  });
  it('omits list options so the server applies the default window and page size', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response(JSON.stringify({ items: [], nextCursor: null }))),
    );
    const api = clientFor(fetch).directRecharges;
    const page = await api.getDirectRechargesPage(walletId);
    expect(page).toEqual({ items: [], nextCursor: null });
    expect(await collect(api.getDirectRecharges(walletId))).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetch.mock.calls) {
      expect(url).toEqual(new URL(`https://partners.example/v1/wallets/${walletId}/direct-recharges`));
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
    await expect(clientFor(fetch).directRecharges.getDirectRechargesPage(walletId, options)).rejects.toMatchObject({
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

  it('sends only public create members and resumes the same id/body with a fresh nonce', async () => {
    const fake = await signedFetchDouble(() => ({
      status: 202,
      body: JSON.stringify(accepted('directRecharge', rechargeId)),
    }));
    const api = clientFor(fake.fetcher).directRecharges;
    const request = {
      ...rechargeIntent,
      expectedTotal: Money.of('237.500', 'LYD', new Date('2026-10-20T00:00:00Z')),
      price: 'must-not-send',
      priceWithCommission: 1,
      extraFee: 1,
      operationId: 'must-not-send',
      customerWhatsappNumber: 'must-not-send',
    };
    expect(await api.create(walletId, rechargeId, request)).toMatchObject({
      kind: 'processing',
      accepted: accepted('directRecharge', rechargeId),
      suggestedDelayMs: 5000,
    });
    expect(await api.resume(walletId, rechargeId, request)).toMatchObject({ kind: 'processing' });
    expect(fake.requests[0]?.body).toEqual(fake.requests[1]?.body);
    expect(JSON.parse(new TextDecoder().decode(fake.requests[0]?.body))).toEqual({
      ...rechargeIntent,
      expectedTotal: { amount: '237.500', currency: 'LYD' },
    });
    const headers = fake.requests.map((row) => new Headers(row.init.headers));
    expect(headers.map((row) => row.get('Idempotency-Key'))).toEqual([rechargeId, rechargeId]);
    expect(headers[0]?.get('Nonce')).not.toBe(headers[1]?.get('Nonce'));
  });
  it('omits contactPhone from the create body when it is not supplied', async () => {
    const fake = await signedFetchDouble(() => ({
      status: 202,
      body: JSON.stringify(accepted('directRecharge', rechargeId)),
    }));
    const { productId, payoutAmount, expectedTotal, recipient } = rechargeIntent;
    await clientFor(fake.fetcher).directRecharges.create(walletId, rechargeId, {
      productId,
      payoutAmount,
      expectedTotal,
      recipient,
    });
    expect(Object.keys(JSON.parse(new TextDecoder().decode(fake.requests[0]?.body)) as object)).not.toContain(
      'contactPhone',
    );
  });
  it.each(['awaitingPayment', 'pending', 'inProgress', 'suspendedDataError', 'rejectedAwaitingRefund', 'future'])(
    'keeps full owner state %s processing, including partial refunds',
    async (status) => {
      const fake = await signedFetchDouble(() => ({
        body: JSON.stringify({ ...publicFixture('circle-partially-refunded'), status }),
      }));
      const result = await clientFor(fake.fetcher).directRecharges.resume(walletId, rechargeId, rechargeIntent);
      expect(result).toMatchObject({
        kind: 'processing',
        directRecharge: { partialRefund: { refundedPayout: '500.000' } },
      });
    },
  );
  it.each(['completed', 'paymentFailed', 'rejectedWithRefund'])(
    'closes full owner %s as a final read rather than notPlaced',
    async (status) => {
      const fake = await signedFetchDouble(() => ({
        body: JSON.stringify({ ...publicFixture('circle-completed'), status }),
      }));
      expect(await clientFor(fake.fetcher).directRecharges.resume(walletId, rechargeId, rechargeIntent)).toMatchObject({
        kind: 'final',
        directRecharge: { status },
      });
    },
  );
  it('does not add idempotency to recipient updates', async () => {
    const fake = await signedFetchDouble(() => ({
      status: 202,
      body: JSON.stringify(accepted('directRecharge', rechargeId)),
      headers: { Location: `/v1/direct-recharges/${rechargeId}` },
    }));
    const request = {
      recipient: [{ key: 'recipient_number', value: '01098765432', name: 'must-not-send' }],
      extraFee: 'must-not-send',
    };
    const result = await clientFor(fake.fetcher).directRecharges.updateRecipient(rechargeId, request);
    expect(result).toEqual({
      kind: 'processing',
      operationId: rechargeId,
      suggestedDelayMs: 5000,
      location: `/v1/direct-recharges/${rechargeId}`,
      accepted: accepted('directRecharge', rechargeId),
    });
    const sent = fake.requests[0];
    const headers = new Headers(sent?.init.headers);
    expect(sent?.init.method).toBe('PATCH');
    expect(sent?.url.pathname).toBe(`/v1/direct-recharges/${rechargeId}/recipient`);
    expect(headers.get('Idempotency-Key')).toBeNull();
    expect(headers.has('Nonce')).toBe(true);
    expect(headers.has('Content-Digest')).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(sent?.body))).toEqual({
      recipient: [{ key: 'recipient_number', value: '01098765432' }],
    });
  });
  it('throws signed recipient refusals as API errors, preserving Unicode fields and extensions', async () => {
    const fields = { recipient_number: 'رقم غير صحيح', FutureField: 'Unknown field' };
    const fake = await signedFetchDouble(() => ({
      status: 422,
      body: JSON.stringify({ status: 422, code: 'validation_failed', extensions: { fields, unknown: { a: true } } }),
    }));
    let error: unknown;
    try {
      await clientFor(fake.fetcher).directRecharges.updateRecipient(rechargeId, { recipient: [] });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ValidationFailedError);
    expect(error).toMatchObject({ problem: { extensions: { fields, unknown: { a: true } } } });
    expect(fake.requests).toHaveLength(1);
  });
  it('keeps signed recipient-state refusals outside purchase results and never retries them', async () => {
    const fake = await signedFetchDouble(() => ({
      status: 409,
      body: '{"status":409,"code":"direct_recharge_not_suspended"}',
    }));
    await expect(
      clientFor(fake.fetcher).directRecharges.updateRecipient(rechargeId, { recipient: [] }),
    ).rejects.toBeInstanceOf(AnisApiError);
    expect(fake.requests).toHaveLength(1);
  });
  it.each(['direct_recharge_product_unavailable', 'amount_out_of_range', 'validation_failed', 'purchase_not_allowed'])(
    'preserves definitive create refusal %s',
    async (code) => {
      const fake = await signedFetchDouble(() => ({ status: 422, body: JSON.stringify({ status: 422, code }) }));
      const api = clientFor(fake.fetcher).directRecharges;
      expect(await api.create(walletId, rechargeId, rechargeIntent)).toMatchObject({
        kind: 'notPlaced',
        refusal: { code },
      });
      expect(await api.resume(walletId, rechargeId, rechargeIntent)).toMatchObject({ kind: 'unknown' });
    },
  );
  it('keeps a verified gateway idempotency conflict unknown on create and resume without replacing the saved intent', async () => {
    const fake = await signedFetchDouble(() => ({
      status: 409,
      body: '{"status":409,"code":"idempotency_conflict"}',
    }));
    const api = clientFor(fake.fetcher).directRecharges;
    for (const result of [
      await api.create(walletId, rechargeId, rechargeIntent),
      await api.resume(walletId, rechargeId, rechargeIntent),
    ]) {
      expect(result).toMatchObject({ kind: 'unknown', operationId: rechargeId, suggestedDelayMs: 5000 });
      if (result.kind !== 'unknown') throw new Error('Expected an unresolved conflict.');
      expect(result.cause).toBeInstanceOf(IdempotencyConflictError);
    }
    expect(fake.requests[0]?.body).toEqual(fake.requests[1]?.body);
    expect(fake.requests).toHaveLength(2);
  });
  it.each([
    [409, 'insufficient_balance'],
    [422, 'validation_failed'],
    [409, 'idempotency_conflict'],
  ] as const)('raises the recorded %i %s refusal on a signed read with the replayed flag', async (status, code) => {
    const fake = await signedFetchDouble(() => ({
      status,
      body: JSON.stringify({ status, code }),
      headers: { 'Idempotency-Replayed': 'true' },
    }));
    const error: unknown = await clientFor(fake.fetcher)
      .directRecharges.get(rechargeId)
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(AnisApiError);
    expect(error).toMatchObject({ code, status, isReplayed: true });
    expect(fake.requests.every((request) => request.init.method === 'GET')).toBe(true);
  });
  it('returns GET accepted separately from full owner data and rejects malformed 202', async () => {
    let wire: unknown = accepted('directRecharge', rechargeId);
    const fake = await signedFetchDouble(() => ({ status: 202, body: JSON.stringify(wire) }));
    const api = clientFor(fake.fetcher).directRecharges;
    expect(await api.get(rechargeId)).toEqual(wire);
    wire = { ...accepted('directRecharge', rechargeId), number: 30412 };
    await expect(api.get(rechargeId)).rejects.toBeInstanceOf(MalformedResponseError);
  });
  it('reads signed complete owner data including proof and recipient fields', async () => {
    const fake = await signedFetchDouble(() => ({ body: JSON.stringify(publicFixture('circle-completed')) }));
    expect(await clientFor(fake.fetcher).directRecharges.get(rechargeId)).toMatchObject({
      operationId: rechargeId,
      status: 'completed',
      exchangeRate: '0.155000',
      recipient: [{ key: 'recipient_name' }, { key: 'recipient_number' }],
    });
  });
  it('pages collection summaries with unchanged filters and explicit-null exhaustion', async () => {
    const from = new Date('2026-10-01T00:00:00Z');
    const to = new Date('2026-10-20T00:00:00Z');
    const fake = await signedFetchDouble((url) => ({
      body: JSON.stringify({
        ...listFixture('direct-recharges'),
        nextCursor: url.searchParams.get('cursor') === '+/=& عربي' ? null : '+/=& عربي',
      }),
    }));
    const rows = await collect(
      clientFor(fake.fetcher).directRecharges.getDirectRecharges(walletId, {
        status: 'completed',
        productId: productId.toUpperCase(),
        from,
        to,
        pageSize: 100,
        cursor: 'first',
      }),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ hasPartialRefund: false, total: { amount: '237.500' } });
    for (const request of fake.requests) {
      expect(Object.fromEntries(request.url.searchParams)).toMatchObject({
        status: 'completed',
        productId,
        from: from.toISOString(),
        to: to.toISOString(),
        pageSize: '100',
      });
      expect(request.body.length).toBe(0);
    }
    expect(fake.requests[0]?.url.searchParams.get('cursor')).toBe('first');
  });
  it('keeps a connection failure unresolved and does not automatically replay a recipient change', async () => {
    let requests = 0;
    const api = clientFor(() => {
      requests++;
      return Promise.reject(new Error('Connection lost'));
    }).directRecharges;
    expect(await api.create(walletId, rechargeId, rechargeIntent)).toMatchObject({
      kind: 'unknown',
      operationId: rechargeId,
    });
    await expect(api.updateRecipient(rechargeId, { recipient: [] })).rejects.toThrow('Connection lost');
    expect(requests).toBe(2);
  });
});
