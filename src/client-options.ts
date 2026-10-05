/** Client settings that select one issued authority and bound signing, caching, and request time. */
export interface ClientOptions {
  /** Issued Anis authority; the host is the only environment selector. */
  authority: string | URL;
  /** Signature lifetime in seconds. Capped at 60 so a request cannot finish after its answer freshness window. */
  signatureLifetimeSeconds?: number;
  /** Optional Arabic or English presentation preference. */
  acceptLanguage?: 'ar' | 'en';
  /** Lifetime of the published response signing-key document cache. */
  signingKeyCacheSeconds?: number;
  /** Per-request timeout; an order timeout leaves its outcome unknown. */
  timeoutMs?: number;
}

/** Applies SDK defaults and rejects settings that could place orders whose answers are already stale. */
export interface ValidatedClientOptions {
  authority: URL;
  signatureLifetimeSeconds: number;
  signingKeyCacheSeconds: number;
  timeoutMs: number;
  acceptLanguage?: 'ar' | 'en';
}

/** Rejects invalid authorities and stale signature lifetimes before a call can become unverifiable or leave an order unresolved. */
export function validateClientOptions(options: ClientOptions): ValidatedClientOptions {
  const authority = new URL(options.authority);
  const hostname = authority.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  if (authority.protocol !== 'https:' && !(authority.protocol === 'http:' && loopback))
    throw new TypeError(
      'Authority must use HTTPS; plain HTTP lets an on-path attacker replace the unsigned key document and read card codes. HTTP is allowed only for loopback testing.',
    );
  if (authority.pathname !== '/' || authority.search || authority.hash)
    throw new TypeError('Authority must not include a path, query, or fragment.');
  const signatureLifetimeSeconds = options.signatureLifetimeSeconds ?? 60;
  const signingKeyCacheSeconds = options.signingKeyCacheSeconds ?? 600;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isInteger(signatureLifetimeSeconds) || signatureLifetimeSeconds < 1 || signatureLifetimeSeconds > 60)
    throw new RangeError('Signature lifetime must be between 1 and 60 seconds.');
  if (!Number.isFinite(signingKeyCacheSeconds) || signingKeyCacheSeconds <= 0)
    throw new RangeError('Signing key cache lifetime must be positive.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('Request timeout must be positive.');
  return {
    authority,
    signatureLifetimeSeconds,
    signingKeyCacheSeconds,
    timeoutMs,
    ...(options.acceptLanguage === undefined ? {} : { acceptLanguage: options.acceptLanguage }),
  };
}
