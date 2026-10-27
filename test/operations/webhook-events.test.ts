import { describe, expect, it } from 'vitest';
import { MalformedResponseError } from '../../src/errors/malformed-response-error.js';
import { signedFetchDouble } from '../support/signed-fetch.js';
import { clientFor, collect, delivery, eventAccepted, eventId, walletId } from './product-test-support.js';

describe('webhook events', () => {
  it('pages by status, inclusive since and opaque cursor, without a public page size or GET body', async () => {
    const since = new Date('2026-10-19T00:00:00Z');
    const fake = await signedFetchDouble((url) => ({
      body: JSON.stringify({ items: [delivery], nextCursor: url.searchParams.has('cursor') ? null : '+/=& عربي' }),
    }));
    const rows = await collect(clientFor(fake.fetcher).webhookEvents.getWebhookEvents({ status: 'failed', since }));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      attempts: 12,
      nextAttemptAt: null,
      lastResponseCode: 503,
      lastFailureKind: 'httpStatus',
    });
    for (const request of fake.requests) {
      expect(Object.fromEntries(request.url.searchParams)).toMatchObject({
        status: 'failed',
        since: since.toISOString(),
      });
      expect(request.url.searchParams.has('pageSize')).toBe(false);
      expect(request.body.length).toBe(0);
    }
    expect(fake.requests[1]?.url.searchParams.get('cursor')).toBe('+/=& عربي');
  });
  it('terminates on an empty page and null next cursor', async () => {
    const fake = await signedFetchDouble(() => ({ body: '{"items":[],"nextCursor":null}' }));
    expect(await collect(clientFor(fake.fetcher).webhookEvents.getWebhookEvents())).toEqual([]);
    expect(fake.requests).toHaveLength(1);
  });
  it('redelivers the same event id using exactly {} and no Idempotency-Key', async () => {
    const fake = await signedFetchDouble(() => ({ status: 202, body: JSON.stringify(eventAccepted) }));
    const result = await clientFor(fake.fetcher).webhookEvents.redeliver(eventId.toUpperCase());
    expect(result).toMatchObject({ id: eventId, status: 'pending' });
    expect(result).not.toHaveProperty('type');
    expect(result).not.toHaveProperty('location');
    const request = fake.requests[0];
    expect(request?.init.method).toBe('POST');
    expect(request?.url.pathname).toBe(`/v1/webhook-events/${eventId}/redeliver`);
    expect(new TextDecoder().decode(request?.body)).toBe('{}');
    expect(new Headers(request?.init.headers).get('Idempotency-Key')).toBeNull();
  });
  it('rejects a mismatched accepted id rather than inventing an event read', async () => {
    const fake = await signedFetchDouble(() => ({
      status: 202,
      body: JSON.stringify({ ...eventAccepted, id: walletId }),
    }));
    await expect(clientFor(fake.fetcher).webhookEvents.redeliver(eventId)).rejects.toBeInstanceOf(
      MalformedResponseError,
    );
    expect(fake.requests).toHaveLength(1);
  });
  it('does not automatically replay an uncertain redelivery', async () => {
    let count = 0;
    const api = clientFor(() => {
      count++;
      return Promise.reject(new Error('Lost answer'));
    }).webhookEvents;
    await expect(api.redeliver(eventId)).rejects.toThrow('Lost answer');
    expect(count).toBe(1);
  });
});
