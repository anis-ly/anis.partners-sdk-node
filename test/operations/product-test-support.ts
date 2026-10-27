import { AnisPartnersClient } from '../../src/client.js';
import { Money } from '../../src/models/money.js';
import { KeyedSigner } from '../../src/signing/keyed-signer.js';

export const walletId = '71825266-7182-4182-8182-718252667182';
export const meterId = '3c1e9b7a-0d42-4f5e-8a61-2b9c7d0e5f13';
export const rechargeId = '7d4e1a90-5b2c-4e7f-8a13-0c9d6e2b4f81';
export const packageId = '5f3b8c21-5f3b-4c21-8f3b-5f3b8c215f3b';
export const productId = 'e7c2a9d4-1b3f-4a85-9c60-8d2e4f7b1a93';
export const eventId = '0f8c3e1a-6c7d-5b1e-9a40-2a1f5c9e7d11';
export const signer = new KeyedSigner({ sign: () => Promise.resolve(new Uint8Array(64)) }, meterId);
export const meterIntent = {
  packageId,
  meterNumber: '0268000710262',
  expectedTotal: Money.of('97.500', 'LYD'),
  externalReference: 'POS-77-INV-1093',
};
export const rechargeIntent = {
  productId,
  payoutAmount: '1500.000',
  expectedTotal: Money.of('237.500', 'LYD'),
  recipient: [{ key: 'recipient_number', value: '01012345678' }],
  note: 'Family support',
  externalReference: 'POS-77-TR-551',
};
export const accepted = (operationType: 'meterCharge' | 'directRecharge', operationId: string) => ({
  operationId,
  operationType,
  status: 'processing',
});
export const clientFor = (fetcher: typeof globalThis.fetch, timeoutMs?: number) =>
  AnisPartnersClient.create({
    options: { authority: 'https://partners.example', ...(timeoutMs === undefined ? {} : { timeoutMs }) },
    signer,
    fetch: fetcher,
  });
export const endpoint = {
  url: 'https://pos.example.ly/hooks/anis?source=نقطة',
  status: 'pendingVerification',
  generation: 7,
};
export const eventAccepted = { id: eventId, status: 'pending', queuedAt: '2026-10-20T08:00:00Z' };
export const delivery = {
  id: eventId,
  type: 'meterCharge.succeeded',
  status: 'failed',
  attempts: 12,
  lastAttemptAt: '2026-10-23T08:00:00Z',
  nextAttemptAt: null,
  lastResponseCode: 503,
  lastFailureKind: 'httpStatus',
};
export const product = {
  id: productId,
  title: 'فودافون كاش مصر',
  type: 'external',
  available: true,
  payoutCurrency: { name: 'جنيه مصري' },
  recipientFields: [
    {
      key: 'recipient_number',
      name: { ar: 'رقم المحفظة', en: 'Wallet number' },
      kind: 'text',
      for: 'recipient',
      order: 1,
      validation: '^01[0-9]{9}$',
      validationMessage: { ar: 'رقم غير صحيح' },
    },
    { key: 'recipient_location', name: { en: 'City' }, kind: 'list', for: 'recipient', order: 2 },
    { key: 'Note', name: { en: 'Note' }, kind: 'note', for: 'sender', order: 3 },
  ],
};
export const quote = {
  productId,
  payout: { amount: '1500.000', currency: { name: 'جنيه مصري' } },
  exchangeRate: '0.155000',
  price: { amount: '232.500', currency: 'LYD' },
  commission: { amount: '5.000', currency: 'LYD' },
  total: { amount: '237.500', currency: 'LYD' },
};
export const meterPackage = {
  id: packageId,
  name: 'باقة 100 دينار',
  gecolPackageName: 'PKG_100',
  logo: 'https://cdn.anis.ly/meter.png',
  unitPrice: { amount: '97.500', currency: 'LYD' },
  personalPrice: { amount: '100.000', currency: 'LYD' },
};
export async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}
