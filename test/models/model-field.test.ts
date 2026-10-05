import { describe, expect, it } from 'vitest';
import {
  parseCatalogueCard,
  parseCatalogueCategoryType,
  parseCatalogueSubcategory,
} from '../../src/models/catalogue.js';
import { parseMaskedCard, parseRevealedCredential } from '../../src/models/cards.js';
import { parseOrder, parseOrderStatus } from '../../src/models/orders.js';

const subcategoryId = '7a1c3e5f-2b4d-4f68-8a0c-9e1b3d5f7a2c';
const cardId = '8d4b1e73-9a25-4c60-8f37-6b2e9d5a1c48';
const soldCardId = '4a6c2e81-7b39-4d15-a2f8-3e7b9c1d5046';
const operationId = '9b2e4f17-3c6a-4d58-b0e1-7a5c8d2f6b34';

describe('model field compatibility', () => {
  it('reads an optional subcategory disclaimer in both languages', () => {
    const subcategory = parseCatalogueSubcategory({
      id: subcategoryId,
      disclaimer: { ar: 'ملاحظة', en: 'Valid in Libya only.' },
    });

    expect(subcategory.disclaimer).toEqual({ ar: 'ملاحظة', en: 'Valid in Libya only.' });
  });

  it('leaves an omitted subcategory disclaimer absent', () => {
    expect(parseCatalogueSubcategory({ id: subcategoryId }).disclaimer).toBeUndefined();
  });

  it('maps an unknown catalogue category type to unknown', () => {
    expect(parseCatalogueCategoryType('regional')).toBe('unknown');
  });

  it('maps an unknown order status to unknown', () => {
    expect(parseOrderStatus('awaiting_owner')).toBe('unknown');
  });

  it('canonicalizes parsed UUID members to lower-case form', () => {
    expect(parseCatalogueSubcategory({ id: subcategoryId.toUpperCase() }).id).toBe(subcategoryId);
  });

  it('reads catalogue card quantity limits', () => {
    const card = parseCatalogueCard({ id: cardId, minimumQuantity: 2, maximumQuantity: 50 });

    expect(card.minimumQuantity).toBe(2);
    expect(card.maximumQuantity).toBe(50);
  });

  it('leaves omitted catalogue card quantity limits absent', () => {
    const card = parseCatalogueCard({ id: cardId });

    expect(card.minimumQuantity).toBeUndefined();
    expect(card.maximumQuantity).toBeUndefined();
  });

  it('reads order reference, failure code, and withheld flag', () => {
    const order = parseOrder({
      operationId,
      status: 'failed',
      externalReference: 'INV-77',
      failureCode: 'out_of_stock',
      codesWithheld: true,
    });

    expect(order.externalReference).toBe('INV-77');
    expect(order.failureCode).toBe('out_of_stock');
    expect(order.codesWithheld).toBe(true);
  });

  it('leaves omitted order additions absent', () => {
    const order = parseOrder({ operationId, status: 'completed' });

    expect(order.externalReference).toBeUndefined();
    expect(order.failureCode).toBeUndefined();
    expect(order.codesWithheld).toBeUndefined();
  });

  it('reads reveal expiry and related credential details', () => {
    const credential = parseRevealedCredential({
      soldCardId,
      voucher: '1234',
      expiryDate: '2027-03-31',
      invoiceId: 'c1a7e2d9-5b64-4f18-9e03-2d7a6c4b8f51',
      card: { id: cardId, name: { ar: 'بطاقة', en: 'Card' } },
      purchasedAt: '2026-09-19T08:00:00Z',
    });

    expect(credential.expiryDate).toBe('2027-03-31');
    expect(credential.invoiceId).toBe('c1a7e2d9-5b64-4f18-9e03-2d7a6c4b8f51');
    expect(credential.card?.id).toBe(cardId);
    expect(credential.card?.name?.en).toBe('Card');
    expect(credential.purchasedAt).toEqual(new Date('2026-09-19T08:00:00Z'));
  });

  it('leaves omitted reveal additions absent', () => {
    const credential = parseRevealedCredential({ soldCardId, voucher: '1234' });

    expect(credential.expiryDate).toBeUndefined();
    expect(credential.invoiceId).toBeUndefined();
    expect(credential.card).toBeUndefined();
    expect(credential.purchasedAt).toBeUndefined();
  });

  it('reads masked card price, expiry, invoice, face value, and subcategory', () => {
    const card = parseMaskedCard({
      id: soldCardId,
      credentialAvailable: false,
      unitPrice: { amount: '10.500', currency: 'LYD' },
      expiryDate: '2027-03-31',
      invoiceNumber: 1042,
      faceValue: '10 USD',
      subcategory: { id: subcategoryId, name: { ar: 'فئة', en: 'Games' } },
    });

    expect(card.unitPrice?.amount).toBe('10.500');
    expect(card.unitPrice?.currency).toBe('LYD');
    expect(card.expiryDate).toBe('2027-03-31');
    expect(card.invoiceNumber).toBe(1042);
    expect(card.faceValue).toBe('10 USD');
    expect(card.subcategory?.id).toBe(subcategoryId);
    expect(card.subcategory?.name?.en).toBe('Games');
    expect(card.credentialAvailable).toBe(false);
  });

  it('leaves omitted masked card additions absent', () => {
    const card = parseMaskedCard({ id: soldCardId, credentialAvailable: true });

    expect(card.unitPrice).toBeUndefined();
    expect(card.expiryDate).toBeUndefined();
    expect(card.invoiceNumber).toBeUndefined();
    expect(card.faceValue).toBeUndefined();
    expect(card.subcategory).toBeUndefined();
  });
});
