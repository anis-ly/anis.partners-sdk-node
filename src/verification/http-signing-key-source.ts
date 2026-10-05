import { createHash } from 'node:crypto';
import type { SigningKeySet } from './partner-jwk.js';
import { parseSigningKeySet } from './partner-jwk.js';
import type { SigningKeyRequestOptions, SigningKeySource } from './signing-key-source.js';
import { UnverifiableResponseError } from './unverifiable-response-error.js';
import { safeCounter, safeLog } from '../internal/safe-telemetry.js';

/** Optional shared cache for serverless instances that do not retain process memory between requests. */
export interface KeyDocumentCache {
  /** Reads a cached document by stable authority key so another instance can avoid a duplicate fetch. */
  get(key: string): Promise<string | undefined>;
  /** Stores the public document for the requested lifetime. */
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

/** Receives non-secret refresh diagnostics without logging response content or key material. */
export interface SigningKeyLogger {
  /** Records the fetch reason and key count without exposing the document. */
  debug(msg: string, fields: Record<string, unknown>): void;
}

/** Options for fetching and caching the sole unsigned public key document. */
export interface HttpSigningKeySourceOptions {
  /** Partner authority whose published keys verify signed responses. */
  authority: string | URL;
  /** Cache duration; ten minutes by default limits requests while allowing key rotation to propagate. */
  cacheSeconds?: number;
  /** Injectable fetch function for hosts and tests that control outbound HTTP. */
  fetch?: typeof globalThis.fetch;
  /** Optional shared cache for serverless hosts with short-lived instances. */
  documentCache?: KeyDocumentCache;
  /** Optional logger that receives only a fetch reason and key count. */
  logger?: SigningKeyLogger;
}

/** Fetches and caches the sole unsigned Partner API document used to verify every signed answer. */
export class HttpSigningKeySource implements SigningKeySource {
  private readonly authority: URL;
  private readonly cacheSeconds: number;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly cache?: KeyDocumentCache;
  private readonly logger?: SigningKeyLogger;
  private cached?: { document: SigningKeySet; until: number };
  private inFlight: { controller: AbortController; waiters: number; promise: Promise<SigningKeySet> } | undefined;

  /** Creates an authority-scoped source; caching avoids a key-document request for every Partner response. */
  constructor(options: HttpSigningKeySourceOptions) {
    this.authority = new URL(options.authority);
    this.cacheSeconds = options.cacheSeconds ?? 600;
    if (!Number.isFinite(this.cacheSeconds) || this.cacheSeconds < 0)
      throw new RangeError('Cache seconds must be non-negative.');
    this.fetcher = options.fetch ?? globalThis.fetch;
    if (options.documentCache !== undefined) this.cache = options.documentCache;
    if (options.logger !== undefined) this.logger = options.logger;
  }

  /** Returns an unexpired document and shares one first-use fetch among concurrent callers. */
  async get(options?: SigningKeyRequestOptions): Promise<SigningKeySet> {
    throwIfAborted(options?.signal);
    if (this.cached && this.cached.until > Date.now()) return this.cached.document;
    if (this.inFlight) return this.waitForFlight(this.inFlight, options?.signal);
    const reason = this.cached ? 'expired' : 'first-use';
    return this.fetchAndCache(reason, options?.signal);
  }

  /** Forces a fetch after rotation or an explicit caller refresh, even when the cache is still fresh. */
  async refresh(options?: SigningKeyRequestOptions): Promise<SigningKeySet> {
    throwIfAborted(options?.signal);
    return this.fetchAndCache('refresh', options?.signal);
  }

  private fetchAndCache(reason: 'first-use' | 'expired' | 'refresh', signal?: AbortSignal): Promise<SigningKeySet> {
    if (this.inFlight) return this.waitForFlight(this.inFlight, signal);
    const controller = new AbortController();
    const promise = this.fetchDocument(reason, controller.signal).finally(() => {
      if (this.inFlight?.controller === controller) this.inFlight = undefined;
    });
    const flight = { controller, waiters: 0, promise };
    this.inFlight = flight;
    return this.waitForFlight(flight, signal);
  }

  private waitForFlight(
    flight: { controller: AbortController; waiters: number; promise: Promise<SigningKeySet> },
    signal?: AbortSignal,
  ): Promise<SigningKeySet> {
    flight.waiters += 1;
    return new Promise((resolve, reject) => {
      let finished = false;
      const release = () => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener('abort', abort);
        flight.waiters -= 1;
      };
      const abort = () => {
        release();
        if (flight.waiters === 0) flight.controller.abort(signal?.reason);
        reject(abortReason(signal));
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener('abort', abort, { once: true });
      flight.promise.then(
        (document) => {
          release();
          resolve(document);
        },
        (error: unknown) => {
          release();
          reject(error instanceof Error ? error : new Error('The signing-key request failed.', { cause: error }));
        },
      );
    });
  }

  private async fetchDocument(
    reason: 'first-use' | 'expired' | 'refresh',
    signal: AbortSignal,
  ): Promise<SigningKeySet> {
    const cacheKey = `anis-partners.signing-keys.${createHash('sha256').update(this.authority.toString().toLowerCase()).digest('hex')}`;
    if (reason === 'first-use' && this.cache) {
      const stored = await this.cache.get(cacheKey);
      if (stored !== undefined) {
        try {
          const document = parseSigningKeySet(stored);
          this.cached = { document, until: Date.now() + this.cacheSeconds * 1000 };
          return document;
        } catch {
          /* Fetch a replaced or malformed shared cache entry. */
        }
      }
    }
    const url = new URL('/.well-known/partner-signing-keys.json', this.authority);
    const response = await this.fetcher(url, {
      headers: { 'Accept-Encoding': 'identity' },
      redirect: 'manual',
      signal,
    });
    const contentEncoding = response.headers.get('content-encoding');
    if (contentEncoding !== null && contentEncoding.toLowerCase() !== 'identity')
      throw new UnverifiableResponseError(
        'content_digest_mismatch',
        'The response was content-encoded, so its received bytes cannot match the signed digest.',
      );
    if (!response.ok) throw new Error(`Signing-key document request failed with HTTP ${String(response.status)}.`);
    const text = await response.text();
    const document = parseSigningKeySet(text);
    this.cached = { document, until: Date.now() + this.cacheSeconds * 1000 };
    await this.cache?.set(cacheKey, text, this.cacheSeconds);
    safeLog(this.logger, 'debug', 'signing keys fetched', { reason, count: document.keys.length });
    safeCounter('anis.partners.signing_keys.fetches', { 'anis.fetch.reason': reason });
    return document;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError');
}
