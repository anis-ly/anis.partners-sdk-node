/** Client settings that select one issued authority and bound signing, caching, and request time. */
export interface ClientOptions {
  /** Issued Anis authority; the host is the only environment selector. */
  authority: string | URL;
  /** Signature lifetime in seconds. Capped at 60 so a request cannot finish after its answer freshness window. */
  signatureLifetimeSeconds?: number | undefined;
  /** Optional Arabic or English presentation preference. */
  acceptLanguage?: 'ar' | 'en' | undefined;
  /** Lifetime of the published response signing-key document cache. */
  signingKeyCacheSeconds?: number | undefined;
  /** Per-request timeout; an order timeout leaves its outcome unknown. */
  timeoutMs?: number | undefined;
  /** Stable host label used for bounded metric dimensions. */
  name?: string | undefined;
}

/** Applies SDK defaults and rejects settings that could place orders whose answers are already stale. */
export interface ValidatedClientOptions {
  authority: URL;
  signatureLifetimeSeconds: number;
  signingKeyCacheSeconds: number;
  timeoutMs: number;
  name: string;
  acceptLanguage?: 'ar' | 'en' | undefined;
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
    throw new RangeError(
      'signatureLifetimeSeconds must be from 1 through 60 so signed order answers remain fresh enough to verify.',
    );
  if (!Number.isFinite(signingKeyCacheSeconds) || signingKeyCacheSeconds <= 0)
    throw new RangeError('signingKeyCacheSeconds must be a positive number.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
    throw new RangeError('timeoutMs must be an integer from 1 through 2147483647.');
  const acceptLanguage: unknown = (options as { acceptLanguage?: unknown }).acceptLanguage;
  if (acceptLanguage !== undefined && acceptLanguage !== 'ar' && acceptLanguage !== 'en')
    throw new TypeError("acceptLanguage must be either 'ar' or 'en'.");
  return {
    authority,
    signatureLifetimeSeconds,
    signingKeyCacheSeconds,
    timeoutMs,
    name: options.name ?? 'default',
    ...(acceptLanguage === undefined ? {} : { acceptLanguage }),
  };
}
