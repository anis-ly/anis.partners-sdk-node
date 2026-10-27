import { describe, expect, it } from 'vitest';
import { AnisApiError } from '../../src/errors/anis-api-error.js';
import { signedFetchDouble } from '../support/signed-fetch.js';
import { clientFor, endpoint, eventAccepted } from './product-test-support.js';

describe('webhook endpoint', () => {
  it('signs the GET request and accepts its unsigned notConfigured answer with explicit nulls', async () => {
    let calls = 0;
    const api = clientFor((_resource, init) => {
      calls++;
      expect(new Headers(init?.headers).has('Signature')).toBe(true);
      expect(init?.body).toBeUndefined();
      return Promise.resolve(new Response('{"url":null,"status":"notConfigured","generation":null}'));
    });
    expect(JSON.stringify(await api.webhookEndpoint.get())).toBe(
      '{"url":null,"status":"notConfigured","generation":null}',
    );
    expect(calls).toBe(1);
  });
  it('sets the exact URL JSON without extra fields or an idempotency key', async () => {
    const fake = await signedFetchDouble(() => ({ body: JSON.stringify(endpoint) }));
    expect(
      await clientFor(fake.fetcher).webhookEndpoint.set({ url: endpoint.url, private: 'must-not-send' } as {
        url: string;
      }),
    ).toEqual(endpoint);
    const sent = fake.requests[0];
    expect(sent?.init.method).toBe('PUT');
    expect(new TextDecoder().decode(sent?.body)).toBe(JSON.stringify({ url: endpoint.url }));
    const headers = new Headers(sent?.init.headers);
    expect(headers.get('Idempotency-Key')).toBeNull();
    expect(headers.has('Nonce')).toBe(true);
    expect(headers.has('Content-Digest')).toBe(true);
  });
  it('queues a signed test over exact empty-object bytes with no idempotency or invented Location', async () => {
    const fake = await signedFetchDouble(() => ({
      status: 202,
      body: JSON.stringify({ ...eventAccepted, type: 'webhook_endpoint.test' }),
    }));
    const api = clientFor(fake.fetcher).webhookEndpoint;
    const first = await api.test();
    await api.test();
    expect(first).toMatchObject({
      ...eventAccepted,
      type: 'webhook_endpoint.test',
      queuedAt: new Date(eventAccepted.queuedAt),
    });
    expect(first).not.toHaveProperty('location');
    expect(fake.requests.map((request) => new TextDecoder().decode(request.body))).toEqual(['{}', '{}']);
    const headers = fake.requests.map((request) => new Headers(request.init.headers));
    expect(headers.every((header) => !header.has('Idempotency-Key'))).toBe(true);
    expect(headers[0]?.get('Nonce')).not.toBe(headers[1]?.get('Nonce'));
  });
  it.each(['set', 'test'] as const)(
    'throws verified %s refusal without purchase recovery or replay',
    async (method) => {
      const fake = await signedFetchDouble(() => ({
        status: 409,
        body: '{"status":409,"code":"webhook_endpoint_unverified"}',
      }));
      const api = clientFor(fake.fetcher).webhookEndpoint;
      await expect(method === 'set' ? api.set({ url: endpoint.url }) : api.test()).rejects.toBeInstanceOf(AnisApiError);
      expect(fake.requests).toHaveLength(1);
    },
  );
  it('does not automatically replay a lost endpoint change', async () => {
    let count = 0;
    const api = clientFor(() => {
      count++;
      return Promise.reject(new Error('Lost answer'));
    }).webhookEndpoint;
    await expect(api.set({ url: endpoint.url })).rejects.toThrow('Lost answer');
    expect(count).toBe(1);
  });
});
