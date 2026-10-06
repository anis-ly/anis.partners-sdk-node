import * as PartnerSdk from '@anis-ly/partners';
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { Money } from '../../src/models/money.js';
import { RequestSigningError } from '../../src/signing/request-signing-error.js';

const require = createRequire(import.meta.url);
const commonJsSdk = require('@anis-ly/partners') as typeof PartnerSdk;

describe('package root exports', () => {
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
