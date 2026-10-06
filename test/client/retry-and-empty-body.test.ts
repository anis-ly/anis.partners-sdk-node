import { describe, expect, it } from 'vitest';
import { AnisPartnersClient } from '../../src/client.js';
import { Money } from '../../src/models/money.js';
import { KeyedSigner } from '../../src/signing/keyed-signer.js';
import { RequestSigningError } from '../../src/signing/request-signing-error.js';
import { signedFetchDouble } from '../support/signed-fetch.js';

const id = 'a9cb2df1-5a48-449b-8c8a-1b20a5b7f433';
const signer = new KeyedSigner({ sign: () => Promise.resolve(new Uint8Array(64)) }, id);
const order = {
  cardId: id,
  quantity: 1,
  expectedUnitPrice: Money.of('1.000', 'LYD'),
  expectedTotal: Money.of('1.000', 'LYD'),
};

describe('order transport retries and empty answers', () => {
  it('shows that a retrying injected fetch repeats the same signed bytes', async () => {
    const base = await signedFetchDouble(() => ({
      status: 201,
      body: `{"operationId":"${id}","status":"completed"}`,
    }));
    const attempts: Headers[] = [];
    const retryingFetch: typeof globalThis.fetch = async (resource, init = {}) => {
      attempts.push(new Headers(init.headers));
      await base.fetcher(resource, init);
      return base.fetcher(resource, init);
    };
    const client = AnisPartnersClient.create({
      options: { authority: 'https://partners.example' },
      signer,
      fetch: retryingFetch,
    });

    const result = await client.orders.create(id, id, order);

    expect(result.kind).toBe('completed');
    expect(base.requests).toHaveLength(2);
    expect(new Headers(base.requests[0]?.init.headers).get('nonce')).toBe(
      new Headers(base.requests[1]?.init.headers).get('nonce'),
    );
    expect(new Headers(base.requests[0]?.init.headers).get('signature')).toBe(
      new Headers(base.requests[1]?.init.headers).get('signature'),
    );
  });

  it('uses a fresh signature and nonce when the caller retries an unknown attempt', async () => {
    const attempted: Headers[] = [];
    const client = AnisPartnersClient.create({
      options: { authority: 'https://partners.example' },
      signer,
      fetch: (_resource, init = {}) => {
        attempted.push(new Headers(init.headers));
        return Promise.reject(new TypeError('connection unavailable'));
      },
    });

    const first = await client.orders.create(id, id, order);
    const second = await client.orders.create(id, id, order);

    expect(first.kind).toBe('unknown');
    expect(second.kind).toBe('unknown');
    expect(attempted).toHaveLength(2);
    expect(attempted[0]?.get('Nonce')).not.toBe(attempted[1]?.get('Nonce'));
    for (const headers of attempted) expect(headers.get('Signature')).toMatch(/^sig1=:/);
  });

  it('does not turn a signer failure into an unknown order', async () => {
    const client = AnisPartnersClient.create({
      options: { authority: 'https://partners.example' },
      signer: new KeyedSigner({ sign: () => Promise.reject(new Error('vault unavailable')) }, id),
      fetch: () => Promise.reject(new Error('request must not be sent')),
    });

    await expect(client.orders.create(id, id, order)).rejects.toBeInstanceOf(RequestSigningError);
  });

  it('rejects a verified JSON null response as a malformed model', async () => {
    const fake = await signedFetchDouble(() => ({ body: 'null' }));
    const client = AnisPartnersClient.create({
      options: { authority: 'https://partners.example' },
      signer,
      fetch: fake.fetcher,
    });

    await expect(client.profile.get()).rejects.toMatchObject({ name: 'MalformedResponseError', model: 'JSON object' });
  });
});
