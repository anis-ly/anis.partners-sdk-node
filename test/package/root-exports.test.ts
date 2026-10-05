import * as PartnerSdk from '@anis-ly/partners';
import { describe, expect, it } from 'vitest';

describe('package root exports', () => {
  it('exports the client surface without transport or verifier internals', () => {
    expect(PartnerSdk.AnisPartnersClient).toBeDefined();
    expect(PartnerSdk.PemP256Signer).toBeDefined();
    expect(PartnerSdk.Money).toBeDefined();
    expect('PartnerTransport' in PartnerSdk).toBe(false);
    expect('PARTNER_ROUTES' in PartnerSdk).toBe(false);
    expect('PartnerResponseVerifier' in PartnerSdk).toBe(false);
    expect('parseSigningKeySet' in PartnerSdk).toBe(false);
    expect('parseWallet' in PartnerSdk).toBe(false);
  });
});
