import { describe, expect, it } from 'vitest';
import { AnisPartnersClient } from '../../src/client.js';
import { Money } from '../../src/models/money.js';
import { KeyedSigner } from '../../src/signing/keyed-signer.js';

const uuid = 'a9cb2df1-5a48-449b-8c8a-1b20a5b7f433';
const signer = new KeyedSigner({ sign: () => Promise.resolve(new Uint8Array(64)) }, uuid);
const price = (amount: string) => Money.of(amount, 'LYD');

describe('order local guards', () => {
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
    ).rejects.toThrow('ExpectedUnitPrice must be greater than zero');
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
    ).rejects.toThrow('ExpectedTotal must equal unit price multiplied by quantity');
  });
});
