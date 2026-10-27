import * as PartnerSdk from '@anis-ly/partners';
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { Money } from '../../src/models/money.js';
import { RequestSigningError } from '../../src/signing/request-signing-error.js';

const require = createRequire(import.meta.url);
const commonJsSdk = require('@anis-ly/partners') as typeof PartnerSdk;

describe('package root exports', () => {
  it('exports every new resource, product parser and webhook verifier', () => {
    for (const symbol of [
      'MeterChargeOperations',
      'DirectRechargeProductOperations',
      'DirectRechargeOperations',
      'WebhookEndpointOperations',
      'WebhookEventOperations',
      'parseProductPage',
      'parseMeterPackage',
      'parseMeterCharge',
      'parseMeterChargeAccepted',
      'parseMeterChargeSummary',
      'parseMeterChargePackage',
      'parseMeterToken',
      'parseMeterTax',
      'parseMeterReceipt',
      'parseMeterFailure',
      'parseMeterRefund',
      'parseMeterChargeStatus',
      'parseMeterRefundStatus',
      'parseMeterFailureCode',
      'parseDirectRechargeProductType',
      'parseDirectRechargeFieldKind',
      'parseDirectRechargeFieldFor',
      'parseDirectRechargeAmountIn',
      'parseDirectRechargeProduct',
      'parseDirectRechargeProductSummary',
      'parseDirectRechargeCategory',
      'parseDirectRechargeLimits',
      'parseDirectRechargeCurrency',
      'parseDirectRechargePayout',
      'parseDirectRechargeRecipientField',
      'parseDirectRechargeLocation',
      'parseDirectRechargeQuote',
      'parseDirectRecharge',
      'parseDirectRechargeAccepted',
      'parseDirectRechargeSummary',
      'parseDirectRechargeStatus',
      'parseDirectRechargeRecipientInput',
      'parseDirectRechargeRecipientValue',
      'parseDirectRechargeProductReference',
      'parseDirectRechargePartialRefund',
      'parseWebhookEndpoint',
      'parseWebhookEventAccepted',
      'parseWebhookEvent',
      'parseWebhookEnvelope',
      'parseWebhookEventType',
      'parseWebhookEndpointStatus',
      'parseWebhookDeliveryStatus',
      'parseWebhookFailureKind',
      'PartnerWebhookVerifier',
      'UnverifiableWebhookError',
    ])
      expect(PartnerSdk).toHaveProperty(symbol);
    const clientType = (client: PartnerSdk.AnisPartnersClient) => [
      client.meterCharges,
      client.directRechargeProducts,
      client.directRecharges,
      client.webhookEndpoint,
      client.webhookEvents,
    ];
    expect(clientType).toBeTypeOf('function');
  });
  it('exports the client surface without transport or verifier internals', () => {
    expect(PartnerSdk.AnisPartnersClient).toBeDefined();
    expect(PartnerSdk.PemP256Signer).toBeDefined();
    expect(PartnerSdk.Money).toBeDefined();
    expect(PartnerSdk.AnisPartnersTelemetry.scope).toBe('@anis-ly/partners');
    expect('PartnerTransport' in PartnerSdk).toBe(false);
    expect('PARTNER_ROUTES' in PartnerSdk).toBe(false);
    expect('PartnerResponseVerifier' in PartnerSdk).toBe(false);
    expect('parseSigningKeySet' in PartnerSdk).toBe(false);
    expect('parseWallet' in PartnerSdk).toBe(false);
  });

  it('shares Money and error brands between the ESM and CommonJS entry points', () => {
    expect(Money.of('10.500', 'LYD')).toBeInstanceOf(commonJsSdk.Money);
    expect(new RequestSigningError(new Error('Signer rejected.'))).toBeInstanceOf(commonJsSdk.RequestSigningError);
  });
});
