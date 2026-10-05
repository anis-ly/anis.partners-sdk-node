import { describe, expect, it } from 'vitest';
import { validateClientOptions } from '../../src/client-options.js';

describe('validateClientOptions', () => {
  it('applies the SDK defaults', () => {
    expect(validateClientOptions({ authority: 'https://partners.example' })).toMatchObject({
      signatureLifetimeSeconds: 60,
      signingKeyCacheSeconds: 600,
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
});
