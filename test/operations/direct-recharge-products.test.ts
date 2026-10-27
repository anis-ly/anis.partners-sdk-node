import { describe, expect, it } from 'vitest';
import { signedFetchDouble } from '../support/signed-fetch.js';
import { clientFor, collect, product, productId, quote, walletId } from './product-test-support.js';

describe('direct recharge products', () => {
  it('pages products while preserving type and cursor encoding', async () => {
    const fake = await signedFetchDouble((url) => ({
      body: JSON.stringify({
        items: [{ ...product, available: false }],
        nextCursor: url.searchParams.has('cursor') ? null : 'a+/=&',
      }),
    }));
    const result = await collect(
      clientFor(fake.fetcher).directRechargeProducts.getDirectRechargeProducts(walletId, { type: 'billing' }),
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ available: false });
    expect(result[0]).not.toHaveProperty('limits');
    expect(fake.requests.map((request) => request.url.searchParams.get('type'))).toEqual(['billing', 'billing']);
    expect(fake.requests[1]?.url.searchParams.get('cursor')).toBe('a+/=&');
    expect(fake.requests[1]?.url.search).toContain('cursor=a%2B%2F%3D%26');
  });
  it('reads the dynamic recipient fields without stripping for or validation', async () => {
    const fake = await signedFetchDouble(() => ({ body: JSON.stringify(product) }));
    const read = await clientFor(fake.fetcher).directRechargeProducts.get(
      walletId.toUpperCase(),
      productId.toUpperCase(),
    );
    expect(read.recipientFields).toMatchObject([
      { key: 'recipient_number', kind: 'text', for: 'recipient', validation: '^01[0-9]{9}$' },
      { kind: 'list' },
      { kind: 'note', for: 'sender' },
    ]);
    expect(fake.requests[0]?.url.pathname).toBe(`/v1/wallets/${walletId}/direct-recharge-products/${productId}`);
  });
  it('walks searched locations, encoding Arabic and opaque cursors exactly once', async () => {
    const search = 'طرابلس + / =&';
    const fake = await signedFetchDouble((url) => ({
      body: JSON.stringify({
        items: [{ id: productId, name: 'القاهرة' }],
        nextCursor: url.searchParams.has('cursor') ? null : '+/=&',
      }),
    }));
    expect(
      await collect(
        clientFor(fake.fetcher).directRechargeProducts.getDirectRechargeProductLocations(walletId, productId, {
          search,
        }),
      ),
    ).toHaveLength(2);
    for (const request of fake.requests) {
      expect(request.url.searchParams.get('search')).toBe(search);
      expect(request.body.length).toBe(0);
    }
    expect(fake.requests[1]?.url.searchParams.get('cursor')).toBe('+/=&');
  });
  it.each(['lyd', 'fx'] as const)('quotes amountIn=%s with exact decimal spellings', async (amountIn) => {
    const fake = await signedFetchDouble(() => ({ body: JSON.stringify(quote) }));
    const result = await clientFor(fake.fetcher).directRechargeProducts.quote(
      walletId,
      productId,
      '1500.000',
      amountIn,
    );
    expect(result.exchangeRate).toBe('0.155000');
    expect(result.total.amount).toBe('237.500');
    expect(result.payout).toEqual({ amount: '1500.000', currency: { name: 'جنيه مصري' } });
    expect(Object.fromEntries(fake.requests[0]?.url.searchParams ?? [])).toEqual({ amount: '1500.000', amountIn });
    expect(fake.requests[0]?.body.length).toBe(0);
  });
  it('refuses unknown quote denomination and non-string or noncanonical amounts before sending', async () => {
    const fake = await signedFetchDouble(() => ({ body: JSON.stringify(quote) }));
    const api = clientFor(fake.fetcher).directRechargeProducts;
    await expect(api.quote(walletId, productId, '1.000', 'usd' as 'fx')).rejects.toThrow(TypeError);
    for (const amount of ['0.000', '-1.000', '1e3', ' 1.000', '1.00', '01.000', 1])
      await expect(api.quote(walletId, productId, amount as string, 'fx')).rejects.toThrow(TypeError);
    expect(fake.requests).toHaveLength(0);
  });
  it('honors caller cancellation on product pages', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Stop'));
    const client = clientFor((_resource, init) =>
      Promise.reject(init?.signal?.reason instanceof Error ? init.signal.reason : new Error('Aborted')),
    );
    await expect(
      client.directRechargeProducts.getDirectRechargeProductsPage(walletId, { signal: controller.signal }),
    ).rejects.toThrow('Stop');
  });
});
