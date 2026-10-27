import { describe, expect, it } from 'vitest';
import { AnisPartnersClient } from '../../src/client.js';
import { validateClientOptions } from '../../src/client-options.js';
import { KeyedSigner } from '../../src/signing/keyed-signer.js';

describe('validateClientOptions', () => {
  it('applies the SDK defaults', () => {
    expect(validateClientOptions({ authority: 'https://partners.example' })).toMatchObject({
      signatureLifetimeSeconds: 60,
      signingKeyCacheSeconds: 300,
      timeoutMs: 30000,
    });
  });

  it('uses caller supplied language, key cache, lifetime, and timeout settings', () => {
    expect(
      validateClientOptions({
        authority: new URL('https://partners.example'),
        signatureLifetimeSeconds: 45,
        acceptLanguage: 'ar',
        signingKeyCacheSeconds: 300,
        timeoutMs: 9000,
      }),
    ).toMatchObject({
      signatureLifetimeSeconds: 45,
      acceptLanguage: 'ar',
      signingKeyCacheSeconds: 300,
      timeoutMs: 9000,
    });
  });

  it('refuses a signature lifetime longer than its answer freshness window', () => {
    expect(() =>
      validateClientOptions({ authority: 'https://partners.example', signatureLifetimeSeconds: 61 }),
    ).toThrow(RangeError);
  });

  it('refuses a key cache longer than five minutes', () => {
    expect(() => validateClientOptions({ authority: 'https://partners.example', signingKeyCacheSeconds: 301 })).toThrow(
      /signingKeyCacheSeconds/,
    );
  });

  it('refuses authorities that include a path', () => {
    expect(() => validateClientOptions({ authority: 'https://partners.example/v1' })).toThrow(TypeError);
  });

  it('requires HTTPS for authorities outside loopback hosts', () => {
    expect(() => validateClientOptions({ authority: 'http://partners.example' })).toThrow(
      'plain HTTP lets an on-path attacker replace the unsigned key document and read card codes',
    );
  });

  it('allows HTTP authorities on loopback for local testing', () => {
    expect(validateClientOptions({ authority: 'http://localhost:7000' }).authority.hostname).toBe('localhost');
    expect(validateClientOptions({ authority: 'http://127.0.0.1:7000' }).authority.hostname).toBe('127.0.0.1');
    expect(validateClientOptions({ authority: 'http://[::1]:7000' }).authority.hostname).toBe('[::1]');
  });

  it.each(['http://localhost:7000', 'http://127.0.0.1:7000', 'http://[::1]:7000'])(
    'creates a client for the loopback authority %s',
    (authority) => {
      const keyId = 'a9cb2df1-5a48-449b-8c8a-1b20a5b7f433';
      const signer = new KeyedSigner({ sign: () => Promise.resolve(new Uint8Array(64)) }, keyId);
      expect(() => AnisPartnersClient.create({ options: { authority }, signer })).not.toThrow();
    },
  );

  it('allows uppercase localhost and refuses nearby non-loopback addresses', () => {
    expect(validateClientOptions({ authority: 'http://LOCALHOST:7000' }).authority.hostname).toBe('localhost');
    expect(() => validateClientOptions({ authority: 'http://127.0.0.2:7000' })).toThrow(/HTTPS/);
  });

  it.each([0, 1.5, 2_147_483_648, Number.NaN])('rejects timeoutMs value %s before creating a client', (timeoutMs) => {
    expect(() => validateClientOptions({ authority: 'https://partners.example', timeoutMs })).toThrow(/timeoutMs/);
  });

  it('rejects a runtime language value outside Arabic and English', () => {
    expect(() =>
      validateClientOptions({ authority: 'https://partners.example', acceptLanguage: 'fr' as 'ar' }),
    ).toThrow(/acceptLanguage/);
  });
});
