import { describe, expect, it, vi } from 'vitest';
import { AnisPartnersClient } from '../../src/client.js';
import { Money } from '../../src/models/money.js';
import { KeyedSigner } from '../../src/signing/keyed-signer.js';
import { signedFetchDouble } from '../support/signed-fetch.js';

const authority = 'https://partners.example';
const keyId = 'a9cb2df1-5a48-449b-8c8a-1b20a5b7f433';
const signer = new KeyedSigner({ sign: () => Promise.resolve(new Uint8Array(64)) }, keyId);
const walletId = '2f1c8a94-6d37-4e52-b8a1-0c9e5d3f7b26';

describe('AnisPartnersClient transport', () => {
  it('rejects invalid identifiers through a promise without throwing synchronously', async () => {
    const client = AnisPartnersClient.create({ options: { authority }, signer });
    const pending = client.wallets.get('not-a-uuid');
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).rejects.toThrow(/UUID/);
  });

  it('clears the request timeout timer after a completed call', async () => {
    vi.useFakeTimers();
    try {
      const fake = await signedFetchDouble(() => ({
        body: `{"id":"${walletId}","balance":{"amount":"10.500","currency":"LYD"}}`,
      }));
      const client = AnisPartnersClient.create({
        options: { authority, timeoutMs: 30_000 },
        signer,
        fetch: fake.fetcher,
      });
      await client.wallets.get(walletId);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('signs a request and parses only the signed response', async () => {
    const fake = await signedFetchDouble(() => ({
      body: `{"id":"${walletId}","balance":{"amount":"10.500","currency":"LYD"}}`,
    }));
    const client = AnisPartnersClient.create({ options: { authority }, signer, fetch: fake.fetcher });

    const wallet = await client.wallets.get(walletId);

    expect(wallet.balance.amount).toBe('10.500');
    expect(fake.requests).toHaveLength(1);
    expect(new Headers(fake.requests[0]?.init.headers).get('Signature')).toMatch(/^sig1=:/);
  });

  it('sends a self-check with exactly an empty JSON object body', async () => {
    const fake = await signedFetchDouble(() => ({ body: '{"coveredComponents":[],"effectiveScopes":[]}' }));
    const client = AnisPartnersClient.create({ options: { authority }, signer, fetch: fake.fetcher });

    await client.diagnostics.checkSignature();

    expect(new TextDecoder().decode(fake.requests[0]?.body)).toBe('{}');
    expect(new Headers(fake.requests[0]?.init.headers).get('Content-Type')).toBe('application/json');
  });

  it('sends a reveal with no body bytes or content type', async () => {
    const fake = await signedFetchDouble(() => ({ body: `{"soldCardId":"${walletId}"}` }));
    const client = AnisPartnersClient.create({ options: { authority }, signer, fetch: fake.fetcher });

    await client.ownedCards.reveal(walletId, walletId);

    expect(fake.requests[0]?.body.byteLength).toBe(0);
    const headers = new Headers(fake.requests[0]?.init.headers);
    expect(headers.get('Content-Type')).toBeNull();
    expect(headers.get('Content-Digest')).toMatch(/^sha-256=:/);
  });

  it('adds the caller language preference to requests', async () => {
    const fake = await signedFetchDouble(() => ({
      body: `{"id":"${walletId}","balance":{"amount":"1","currency":"LYD"}}`,
    }));
    const client = AnisPartnersClient.create({
      options: { authority, acceptLanguage: 'ar' },
      signer,
      fetch: fake.fetcher,
    });

    await client.wallets.get(walletId);

    expect(new Headers(fake.requests[0]?.init.headers).get('Accept-Language')).toBe('ar');
  });

  it('keeps explicit clients on their own signing key and authority', async () => {
    const first = await signedFetchDouble(() => ({
      body: `{"id":"${walletId}","balance":{"amount":"1","currency":"LYD"}}`,
    }));
    const second = await signedFetchDouble(() => ({
      body: `{"id":"${walletId}","balance":{"amount":"2","currency":"LYD"}}`,
    }));
    const firstId = 'a9cb2df1-5a48-449b-8c8a-1b20a5b7f433';
    const secondId = '9b2e4f17-3c6a-4d58-b0e1-7a5c8d2f6b34';
    const firstClient = AnisPartnersClient.create({
      options: { authority: 'https://first.example' },
      signer: new KeyedSigner({ sign: () => Promise.resolve(new Uint8Array(64)) }, firstId),
      fetch: first.fetcher,
    });
    const secondClient = AnisPartnersClient.create({
      options: { authority: 'https://second.example' },
      signer: new KeyedSigner({ sign: () => Promise.resolve(new Uint8Array(64)) }, secondId),
      fetch: second.fetcher,
    });

    expect((await firstClient.wallets.get(walletId)).balance.amount).toBe('1.000');
    expect((await secondClient.wallets.get(walletId)).balance.amount).toBe('2.000');
    expect(first.requests[0]?.url.origin).toBe('https://first.example');
    expect(second.requests[0]?.url.origin).toBe('https://second.example');
    expect(new Headers(first.requests[0]?.init.headers).get('Signature-Input')).toContain(`keyid="${firstId}"`);
    expect(new Headers(second.requests[0]?.init.headers).get('Signature-Input')).toContain(`keyid="${secondId}"`);
  });

  it('sends an order under the caller idempotency key and returns its credentials', async () => {
    const operationId = 'b26bf827-8484-44aa-987a-b033e4cfa401';
    const soldCardId = '6e5b2d70-4416-4a6e-900a-5528803a6a7d';
    const fake = await signedFetchDouble(() => ({
      status: 201,
      body: `{"operationId":"${operationId}","status":"completed","soldCards":[{"soldCardId":"${soldCardId}","voucher":"secret-voucher"}]}`,
    }));
    const client = AnisPartnersClient.create({ options: { authority }, signer, fetch: fake.fetcher });

    const result = await client.orders.create(walletId, operationId, {
      cardId: walletId,
      quantity: 1,
      expectedUnitPrice: Money.of('10.500', 'LYD'),
      expectedTotal: Money.of('10.500', 'LYD'),
    });

    expect(result.kind).toBe('completed');
    expect(new Headers(fake.requests[0]?.init.headers).get('Idempotency-Key')).toBe(operationId);
    expect(new TextDecoder().decode(fake.requests[0]?.body)).toContain('10.500');
  });

  it('returns processing with the signed retry delay', async () => {
    const operationId = 'b26bf827-8484-44aa-987a-b033e4cfa401';
    const fake = await signedFetchDouble(() => ({
      status: 202,
      headers: { 'Retry-After': '9', Location: '/v1/orders/status' },
      body: `{"operationId":"${operationId}","status":"processing"}`,
    }));
    const client = AnisPartnersClient.create({ options: { authority }, signer, fetch: fake.fetcher });

    const result = await client.orders.create(walletId, operationId, {
      cardId: walletId,
      quantity: 1,
      expectedUnitPrice: Money.of('10.500', 'LYD'),
      expectedTotal: Money.of('10.500', 'LYD'),
    });

    expect(result).toMatchObject({ kind: 'processing', suggestedDelayMs: 9000, location: '/v1/orders/status' });
  });

  it('walks wallet pages using the server cursor', async () => {
    let calls = 0;
    const fake = await signedFetchDouble(() => {
      calls += 1;
      const id = calls === 1 ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222';
      return {
        body: JSON.stringify({
          items: [{ id, name: String(calls), balance: { amount: '1', currency: 'LYD' } }],
          ...(calls === 1 ? { nextCursor: 'next-1' } : {}),
        }),
      };
    });
    const client = AnisPartnersClient.create({ options: { authority }, signer, fetch: fake.fetcher });

    const names: string[] = [];
    for await (const wallet of client.wallets.list()) names.push(wallet.name ?? '');

    expect(names).toEqual(['1', '2']);
    expect(fake.requests[1]?.url.search).toBe('?cursor=next-1');
  });
});
