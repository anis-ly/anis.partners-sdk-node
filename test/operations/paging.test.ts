import { describe, expect, it } from 'vitest';
import { AnisPartnersClient } from '../../src/client.js';
import { KeyedSigner } from '../../src/signing/keyed-signer.js';
import { signedFetchDouble } from '../support/signed-fetch.js';

const wallet = '2f1c8a94-6d37-4e52-b8a1-0c9e5d3f7b26';
const subcategory = '7a1c3e5f-2b4d-4f68-8a0c-9e1b3d5f7a2c';
const signer = new KeyedSigner({ sign: () => Promise.resolve(new Uint8Array(64)) }, wallet);
const clientFor = (fetch: typeof globalThis.fetch) =>
  AnisPartnersClient.create({ options: { authority: 'https://partners.example' }, signer, fetch });

describe('cursor paging', () => {
  it('accepts the cursor and signal in one page options object', async () => {
    const fake = await signedFetchDouble(() => ({ body: '{"items":[]}' }));
    const controller = new AbortController();

    await clientFor(fake.fetcher).wallets.listPage({ cursor: 'next', signal: controller.signal });

    expect(fake.requests[0]?.url.search).toBe('?cursor=next');
    expect(fake.requests[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(fake.requests[0]?.init.signal?.aborted).toBe(false);
  });

  it('walks owned card pages', async () => {
    let page = 0;
    const fake = await signedFetchDouble(() => {
      page += 1;
      const card = page === 1 ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222';
      return { body: JSON.stringify({ items: [{ id: card }], ...(page === 1 ? { nextCursor: 'next' } : {}) }) };
    });

    const cards: string[] = [];
    for await (const item of clientFor(fake.fetcher).ownedCards.list(wallet)) cards.push(item.id);

    expect(cards).toHaveLength(2);
    expect(fake.requests[1]?.url.search).toBe('?cursor=next');
  });

  it('walks catalogue card pages for a wallet-priced subcategory', async () => {
    let page = 0;
    const fake = await signedFetchDouble(() => {
      page += 1;
      const card = page === 1 ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222';
      return { body: JSON.stringify({ items: [{ id: card }], ...(page === 1 ? { nextCursor: 'more' } : {}) }) };
    });

    const cards: string[] = [];
    for await (const item of clientFor(fake.fetcher).catalogue.listCards(wallet, subcategory)) cards.push(item.id);

    expect(cards).toHaveLength(2);
    expect(fake.requests[1]?.url.search).toBe('?cursor=more');
  });

  it('walks category and subcategory pages while preserving their parent ids', async () => {
    let page = 0;
    const fake = await signedFetchDouble(() => {
      page += 1;
      const category = page === 1 ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222';
      return { body: JSON.stringify({ items: [{ id: category }], ...(page === 1 ? { nextCursor: 'next' } : {}) }) };
    });
    const client = clientFor(fake.fetcher);
    const categoryIds: string[] = [];
    for await (const item of client.catalogue.listCategories(wallet)) categoryIds.push(item.id);
    expect(categoryIds).toHaveLength(2);
    expect(fake.requests[1]?.url.search).toBe('?cursor=next');

    page = 0;
    const subcategories: string[] = [];
    for await (const item of client.catalogue.listSubcategories(
      wallet,
      categoryIds[0] ?? '11111111-1111-4111-8111-111111111111',
    ))
      subcategories.push(item.id);
    expect(subcategories).toHaveLength(2);
    expect(fake.requests[3]?.url.pathname).toContain(`/catalog/categories/${String(categoryIds[0])}/subcategories`);
  });
});
