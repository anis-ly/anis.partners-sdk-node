import { describe, expect, it } from 'vitest';
import { AnisPartnersClient } from '../../src/client.js';
import type { CreateOrderRequest } from '../../src/models/orders.js';
import { Money } from '../../src/models/money.js';
import { KeyedSigner } from '../../src/signing/keyed-signer.js';

const uuid = 'a9cb2df1-5a48-449b-8c8a-1b20a5b7f433';
const signer = new KeyedSigner({ sign: () => Promise.resolve(new Uint8Array(64)) }, uuid);
const price = (amount: string) => Money.of(amount, 'LYD');

describe('order local guards', () => {
  it.each([
    ['zero quantity', { quantity: 0, expectedUnitPrice: price('1.000'), expectedTotal: price('0.000') }, RangeError],
    ['zero price', { quantity: 1, expectedUnitPrice: price('0.000'), expectedTotal: price('0.000') }, RangeError],
    [
      'currency mismatch',
      { quantity: 1, expectedUnitPrice: price('1.000'), expectedTotal: Money.of('1.000', 'USD') },
      TypeError,
    ],
    ['total mismatch', { quantity: 2, expectedUnitPrice: price('1.000'), expectedTotal: price('1.000') }, TypeError],
    ['non-Money price', { quantity: 1, expectedUnitPrice: 1, expectedTotal: price('1.000') }, TypeError],
  ])(
    'rejects %s as an argument error before create or resume sends a request',
    async (_description, values, ErrorType) => {
      let requests = 0;
      const client = AnisPartnersClient.create({
        options: { authority: 'https://partners.example' },
        signer,
        fetch: () => {
          requests += 1;
          return Promise.reject(new Error('must not send'));
        },
      });
      const invalid = { cardId: uuid, ...values } as unknown as CreateOrderRequest;

      await expect(client.orders.create(uuid, uuid, invalid)).rejects.toBeInstanceOf(ErrorType);
      await expect(client.orders.resume(uuid, uuid, invalid)).rejects.toBeInstanceOf(ErrorType);
      expect(requests).toBe(0);
    },
  );

  it('refuses a negative thousandth price before making a request', async () => {
    let sent = false;
    const client = AnisPartnersClient.create({
      options: { authority: 'https://partners.example' },
      signer,
      fetch: () => {
        sent = true;
        return Promise.reject(new Error('must not send'));
      },
    });

    await expect(
      client.orders.create(uuid, uuid, {
        cardId: uuid,
        quantity: 1,
        expectedUnitPrice: price('-0.001'),
        expectedTotal: price('-0.001'),
      }),
    ).rejects.toThrow('ExpectedUnitPrice must be greater than zero.');
    expect(sent).toBe(false);
  });

  it('refuses an order total that differs from exact integer multiplication', async () => {
    const client = AnisPartnersClient.create({ options: { authority: 'https://partners.example' }, signer });

    await expect(
      client.orders.create(uuid, uuid, {
        cardId: uuid,
        quantity: 2,
        expectedUnitPrice: price('10.500'),
        expectedTotal: price('20.000'),
      }),
    ).rejects.toThrow('ExpectedTotal must equal unit price multiplied by quantity.');
  });

  it('rejects a non-canonical order id directly before making a request', async () => {
    let sent = false;
    const client = AnisPartnersClient.create({
      options: { authority: 'https://partners.example' },
      signer,
      fetch: () => {
        sent = true;
        return Promise.reject(new Error('must not send'));
      },
    });
    const validOrder = {
      cardId: uuid,
      quantity: 1,
      expectedUnitPrice: price('1.000'),
      expectedTotal: price('1.000'),
    };

    await expect(client.orders.create(uuid, 'not-a-uuid', validOrder)).rejects.toBeInstanceOf(TypeError);
    await expect(client.orders.resume(uuid, 'not-a-uuid', validOrder)).rejects.toBeInstanceOf(TypeError);
    expect(sent).toBe(false);
  });

  it('rejects an invalid id on another operation directly before making a request', async () => {
    let sent = false;
    const client = AnisPartnersClient.create({
      options: { authority: 'https://partners.example' },
      signer,
      fetch: () => {
        sent = true;
        return Promise.reject(new Error('must not send'));
      },
    });

    await expect(client.wallets.get('not-a-uuid')).rejects.toBeInstanceOf(TypeError);
    expect(sent).toBe(false);
  });
});
