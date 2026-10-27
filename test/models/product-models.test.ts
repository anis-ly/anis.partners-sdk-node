import { describe, expect, it } from 'vitest';
import { parseMoney } from '../../src/models/money.js';
import {
  parseMeterCharge,
  parseMeterChargeAccepted,
  parseMeterChargeSummary,
  parseMeterFailure,
  parseMeterPackage,
  parseMeterReceipt,
} from '../../src/models/meter-charges.js';
import {
  parseDirectRecharge,
  parseDirectRechargeAccepted,
  parseDirectRechargeSummary,
} from '../../src/models/direct-recharges.js';
import {
  parseDirectRechargeProduct,
  parseDirectRechargeProductSummary,
  parseDirectRechargeQuote,
} from '../../src/models/direct-recharge-products.js';
import {
  parseWebhookEndpoint,
  parseWebhookEvent,
  parseWebhookEventAccepted,
  parseWebhookEnvelope,
} from '../../src/models/webhooks.js';
import { parseProductPage } from '../../src/models/product-page.js';
import { publicFixture, envelopeFixture, listFixture } from './product-fixtures.js';
import {
  accepted,
  delivery,
  endpoint,
  eventAccepted,
  meterId,
  meterPackage,
  product,
  quote,
  rechargeId,
} from '../operations/product-test-support.js';

const fixtureNames = [
  'meter-succeeded',
  'meter-failed-refunded',
  'meter-failed-not-charged',
  'meter-failed-pending',
  'circle-paid',
  'circle-payment-failed',
  'circle-suspended',
  'circle-suspended-after-recipient-fix',
  'circle-completed',
  'circle-rejected',
  'circle-partially-refunded',
];

describe('product models', () => {
  it.each(fixtureNames)('parses the shared %s read and envelope fixtures', (name) => {
    const wire = publicFixture(name);
    const read = name.startsWith('meter') ? parseMeterCharge(wire) : parseDirectRecharge(wire);
    const wireEnvelope = envelopeFixture(name);
    if (wireEnvelope === null) {
      expect(name).toBe('meter-failed-pending');
      expect(() => parseWebhookEnvelope(wireEnvelope)).toThrow(TypeError);
    } else {
      const envelope = parseWebhookEnvelope(wireEnvelope);
      expect(envelope.data).toEqual(read);
      expect(envelope.rawType).toBe(wireEnvelope.type);
    }
    expect(read.operationId).toBe(wire.operationId);
    expect(JSON.parse(JSON.stringify(read))).toMatchObject({
      ...wire,
      ...Object.fromEntries(
        ['createdAt', 'requestedAt', 'completedAt'].flatMap((field) => {
          const value = wire[field];
          return typeof value === 'string' ? [[field, new Date(value).toISOString()]] : [];
        }),
      ),
    });
  });
  it('SuspendedType_CurrentInProgressData_IsAccepted', () => {
    const result = parseWebhookEnvelope(envelopeFixture('circle-suspended-after-recipient-fix'));
    expect(result.type).toBe('directRecharge.suspended');
    expect(result.data.status).toBe('inProgress');
  });
  it('preserves a negative balance', () => {
    const balance = parseMoney({ amount: '-150.000', currency: 'LYD' });
    expect(balance.amount).toBe('-150.000');
    expect(balance.toJSON()).toEqual({ amount: '-150.000', currency: 'LYD' });
  });
  it('parses both list fixtures without fabricating full-read fields', () => {
    const meters = parseProductPage(listFixture('meter-charges'), parseMeterChargeSummary);
    const recharges = parseProductPage(listFixture('direct-recharges'), parseDirectRechargeSummary);
    expect(meters.items[0]).toMatchObject({
      operationId: meterId,
      meterNumber: '0268000710262',
      total: { amount: '97.500' },
    });
    expect(recharges.items[0]).toMatchObject({
      operationId: rechargeId,
      payout: { amount: '1500.000' },
      hasPartialRefund: false,
    });
    expect(meters.nextCursor).toBeNull();
    expect(recharges.nextCursor).toBeNull();
    expect(meters.items[0]).not.toHaveProperty('receipt');
    expect(recharges.items[0]).not.toHaveProperty('recipient');
  });
  it('retains every token in order, spaces, sequence gaps and upstream scale', () => {
    const receipt = parseMeterReceipt({
      receiptNumber: '001',
      creditedAmount: '88.64000',
      tokens: [
        { sequence: 1, label: 'KCT1', code: '1234  5678', description: null },
        { sequence: 3, label: 'STS', code: '0000  0001' },
      ],
      taxes: [{ description: 'ضريبة الاستهلاك', amount: '3.86000' }],
    });
    expect(receipt.tokens.map((token) => token.sequence)).toEqual([1, 3]);
    expect(receipt.tokens[0]?.code).toBe('1234  5678');
    expect(receipt.creditedAmount).toBe('88.64000');
    expect(receipt.taxes[0]).toEqual({ description: 'ضريبة الاستهلاك', amount: '3.86000' });
  });
  it('requires frozen prices and genesis time on full meter reads, including processing', () => {
    const wire: Record<string, unknown> = { ...publicFixture('meter-succeeded'), status: 'processing' };
    delete wire.receipt;
    delete wire.completedAt;
    const parsed = parseMeterCharge(wire);
    expect(parsed).not.toHaveProperty('receipt');
    expect(parsed).not.toHaveProperty('completedAt');
    for (const field of ['total', 'personalPrice', 'createdAt', 'walletId', 'package', 'meterNumber']) {
      const malformed = without(wire, field);
      expect(() => parseMeterCharge(malformed)).toThrow(TypeError);
    }
    expect(parseMeterCharge({ ...wire, total: { amount: '0.000', currency: 'LYD' } }).total.amount).toBe('0.000');
  });
  it.each([
    'meter_number_invalid',
    'meter_not_whitelisted',
    'meter_not_linked',
    'meter_removed',
    'meter_inactive',
    'meter_account_blocked',
    'meter_data_incomplete',
    'meter_debt_exceeds_package',
    'package_unavailable',
    'package_limit_reached',
    'token_not_written',
    'insufficient_balance',
    'gecol_unavailable',
    'charge_failed',
  ])('recognizes body failure %s', (code) => {
    expect(parseMeterFailure({ code, message: { ar: 'رفض' } })).toEqual({
      code,
      rawCode: code,
      message: { ar: 'رفض' },
    });
  });
  it('preserves future snake-case and dotted values without classifying a financial success', () => {
    expect(parseMeterFailure({ code: 'future_failure', message: { en: 'Future' } })).toMatchObject({
      code: 'unknown',
      rawCode: 'future_failure',
    });
    expect(parseMeterCharge({ ...publicFixture('meter-succeeded'), status: 'future' }).status).toBe('unknown');
    expect(parseDirectRecharge({ ...publicFixture('circle-completed'), status: 'future' }).status).toBe('unknown');
    expect(
      parseWebhookEvent({ ...delivery, type: 'future.event', status: 'future', lastFailureKind: 'future' }),
    ).toMatchObject({ type: 'unknown', rawType: 'future.event', status: 'unknown', lastFailureKind: 'unknown' });
  });
  it.each(['refunded', 'not-charged', 'pending'])(
    'parses failed refund %s without a synthetic completion time',
    (suffix) => {
      const read = parseMeterCharge(publicFixture(`meter-failed-${suffix}`));
      expect(read.status).toBe('failed');
      expect(read.completedAt).toBeUndefined();
      if (suffix === 'not-charged') expect(read.refund).not.toHaveProperty('amount');
      else expect(read.refund?.amount?.amount).toBe('97.500');
    },
  );
  it('keeps absent package business price and unavailable tier limits absent', () => {
    expect(parseMeterPackage(meterPackage)).not.toHaveProperty('businessPrice');
    const read = parseDirectRechargeProductSummary({ ...product, available: false });
    expect(read.available).toBe(false);
    expect(read).not.toHaveProperty('limits');
    expect(parseDirectRechargeProductSummary({ ...product, limits: { minimumPayout: '50.000' } }).limits).toEqual({
      minimumPayout: '50.000',
    });
  });
  it('accepts the members the contract marks optional when they are absent', () => {
    const withoutLogo: Record<string, unknown> = { ...meterPackage };
    delete withoutLogo.logo;
    expect(parseMeterPackage(withoutLogo)).not.toHaveProperty('logo');
    expect(parseMeterFailure({ code: 'meter_not_whitelisted' })).toEqual({
      code: 'meter_not_whitelisted',
      rawCode: 'meter_not_whitelisted',
    });
    const field = { key: 'recipient_number', kind: 'text', for: 'recipient', order: 1 };
    expect(parseDirectRechargeProduct({ ...product, recipientFields: [field] }).recipientFields).toEqual([
      { key: 'recipient_number', kind: 'text', for: 'recipient', order: 1 },
    ]);
    const read = parseDirectRecharge({
      ...publicFixture('circle-completed'),
      recipient: [{ key: 'recipient_number', value: '01012345678' }],
    });
    expect(read.recipient).toEqual([{ key: 'recipient_number', value: '01012345678' }]);
  });
  it('preserves dynamic for metadata, currencies, quote rate and optional field definitions', () => {
    const read = parseDirectRechargeProduct(product);
    expect(read.recipientFields.map((field) => field.for)).toEqual(['recipient', 'recipient', 'sender']);
    expect(read.recipientFields[0]?.validation).toBe('^01[0-9]{9}$');
    expect(read.recipientFields[1]).not.toHaveProperty('validation');
    expect(parseDirectRechargeQuote(quote)).toMatchObject({
      exchangeRate: '0.155000',
      payout: { amount: '1500.000', currency: { name: 'جنيه مصري' } },
    });
    expect(
      parseDirectRechargeProduct({
        ...product,
        type: 'future',
        recipientFields: [{ ...product.recipientFields[0], kind: 'future', for: 'future' }],
      }),
    ).toMatchObject({ type: 'unknown', recipientFields: [{ kind: 'unknown', for: 'unknown' }] });
  });
  it.each([
    'awaitingPayment',
    'paymentFailed',
    'pending',
    'inProgress',
    'suspendedDataError',
    'completed',
    'rejectedAwaitingRefund',
    'rejectedWithRefund',
  ])('parses direct recharge state %s without inventing optional fields', (status) => {
    const read = parseDirectRecharge({ ...publicFixture('circle-paid'), status });
    expect(read.status).toBe(status);
    expect(read.proofUrl).toBeUndefined();
    expect(read.reason).toBeUndefined();
  });
  it.each(['meterCharge', 'directRecharge'] as const)('requires exactly the O-01 %s acknowledgement', (type) => {
    const parse = type === 'meterCharge' ? parseMeterChargeAccepted : parseDirectRechargeAccepted;
    const wire = accepted(type, type === 'meterCharge' ? meterId : rechargeId);
    expect(parse(wire)).toEqual(wire);
    const bad: unknown[] = [
      { ...wire, extra: true },
      { ...wire, operationType: 'wrong' },
      { ...wire, status: 'completed' },
      { ...wire, operationId: 42 },
    ];
    for (const field of ['operationId', 'operationType', 'status']) {
      const missing = without(wire, field);
      bad.push(missing);
    }
    for (const value of bad) expect(() => parse(value)).toThrow(TypeError);
  });
  it.each(['meterCharge.succeeded', 'directRecharge.completed'])('throws on malformed known %s data', (type) => {
    const wire = { ...envelopeFixture('meter-succeeded'), type, data: { status: 'completed' } };
    expect(() => parseWebhookEnvelope(wire)).toThrow(TypeError);
  });
  it.each(['future.event', 'webhook_endpoint.test', 'webhook_endpoint.verification'])(
    'keeps raw %s data without interpreting a financial outcome',
    (type) => {
      const data = { message: 'اختبار', generation: 7, challenge: 'raw', nested: [null, { ok: true }] };
      expect(parseWebhookEnvelope({ ...envelopeFixture('meter-succeeded'), type, data })).toMatchObject({
        type: 'unknown',
        rawType: type,
        data,
      });
    },
  );
  it.each([null, [], 'data', 1, undefined])('rejects an envelope whose data is not an object: %j', (data) => {
    expect(() => parseWebhookEnvelope({ ...envelopeFixture('meter-succeeded'), type: 'future.event', data })).toThrow(
      TypeError,
    );
  });
  it('requires valid envelope identities, event time and JSON data', () => {
    const good: Record<string, unknown> = { ...envelopeFixture('meter-succeeded'), type: 'future.event', data: {} };
    for (const field of ['id', 'applicationId', 'occurredAt', 'type']) {
      const bad = without(good, field);
      expect(() => parseWebhookEnvelope(bad)).toThrow(TypeError);
    }
    expect(() => parseWebhookEnvelope({ ...good, occurredAt: '2026-02-31T00:00:00Z' })).toThrow(TypeError);
    expect(() => parseWebhookEnvelope({ ...good, data: { bad: undefined } })).toThrow(TypeError);
  });
  it.each(['notConfigured', 'pendingVerification', 'verified', 'disabled'])(
    'parses endpoint %s with explicit nullable keys',
    (status) => {
      const read = parseWebhookEndpoint({
        ...endpoint,
        status,
        ...(status === 'notConfigured' ? { url: null, generation: null } : {}),
      });
      expect(read.status).toBe(status);
      if (status === 'notConfigured')
        expect(JSON.parse(JSON.stringify(read))).toEqual({ status, url: null, generation: null });
    },
  );
  it('preserves every nullable delivery key through JSON serialization and rejects missing members', () => {
    const wire = {
      ...delivery,
      lastAttemptAt: null,
      nextAttemptAt: null,
      lastResponseCode: null,
      lastFailureKind: null,
    };
    expect(JSON.parse(JSON.stringify(parseWebhookEvent(wire)))).toMatchObject(wire);
    for (const field of ['lastAttemptAt', 'nextAttemptAt', 'lastResponseCode', 'lastFailureKind']) {
      const bad = without(wire, field);
      expect(() => parseWebhookEvent(bad)).toThrow(TypeError);
    }
    for (const field of ['url', 'generation']) {
      const bad = without(endpoint, field);
      expect(() => parseWebhookEndpoint(bad)).toThrow(TypeError);
    }
  });
  it('requires accepted event identities and queue times without inventing event type', () => {
    expect(parseWebhookEventAccepted(eventAccepted)).not.toHaveProperty('type');
    expect(() => parseWebhookEventAccepted({ ...eventAccepted, status: 'queued' })).toThrow(TypeError);
    expect(() => parseWebhookEventAccepted({ ...eventAccepted, queuedAt: null })).toThrow(TypeError);
  });
});

function without(value: Record<string, unknown>, field: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
}
