import { createHash } from 'node:crypto';
import type { SigningKeySet } from './partner-jwk.js';
import { parseSigningKeySet } from './partner-jwk.js';
import type { SigningKeyRequestOptions, SigningKeySource } from './signing-key-source.js';
import { safeCounter, safeLog } from '../internal/safe-telemetry.js';
import { SigningKeyDocumentUnavailableError } from '../errors/signing-key-document-unavailable-error.js';

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
  debug?(msg: string, fields: Record<string, unknown>): void;
  /** Records a successful document fetch as an informational event. */
  info?(msg: string, fields: Record<string, unknown>): void;
  /** Records a shared-cache write failure without affecting response verification. */
  warn?(msg: string, fields: Record<string, unknown>): void;
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
  /** Optional logger that receives cache reads, fetch reasons, and key counts without key material. */
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
    if (this.cached && this.cached.until > performance.now()) return this.cached.document;
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
        if (flight.waiters === 0) {
          if (this.inFlight?.controller === flight.controller) this.inFlight = undefined;
          flight.controller.abort(signal?.reason);
        }
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
    const normalizedAuthority = this.authority.toString().toLowerCase().replace(/\/+$/, '');
    const cacheKey = `anis_partners_keys_${createHash('sha256').update(normalizedAuthority).digest('hex').slice(0, 32)}`;
    if (reason === 'first-use' && this.cache) {
      const cached = await settleCache(() => this.cache?.get(cacheKey) ?? Promise.resolve(undefined), signal);
      throwIfAborted(signal);
      const stored = cached.ok ? cached.value : undefined;
      if (stored !== undefined) {
        try {
          const envelope: unknown = JSON.parse(stored);
          if (isCacheEnvelope(envelope)) {
            const nowSeconds = Date.now() / 1000;
            const remainingMs = (envelope.fetchedAt + this.cacheSeconds - nowSeconds) * 1000;
            if (remainingMs > 0 && envelope.fetchedAt <= nowSeconds + 60) {
              const document = parseSigningKeySet(envelope.document);
              this.cached = { document, until: performance.now() + remainingMs };
              safeLog(this.logger, 'debug', 'signing keys read from the shared cache', {});
              return document;
            }
          }
        } catch {
          /* Fetch a replaced or malformed shared cache entry. */
        }
      }
    }
    const url = new URL('/.well-known/partner-signing-keys.json', this.authority);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        headers: { 'Accept-Encoding': 'identity' },
        redirect: 'manual',
        signal,
      });
    } catch {
      if (signal.aborted) throw abortReason(signal);
      throw new SigningKeyDocumentUnavailableError();
    }
    if (!response.ok) {
      await cancelBody(response);
      throw new SigningKeyDocumentUnavailableError();
    }
    const contentEncoding = response.headers.get('content-encoding');
    if (contentEncoding !== null && contentEncoding.toLowerCase() !== 'identity') {
      await cancelBody(response);
      throw new SigningKeyDocumentUnavailableError();
    }
    let text: string;
    let document: SigningKeySet;
    try {
      text = await response.text();
      document = parseSigningKeySet(text);
    } catch {
      if (signal.aborted) throw abortReason(signal);
      throw new SigningKeyDocumentUnavailableError();
    }
    const fetchedAt = Math.floor(Date.now() / 1000);
    this.cached = { document, until: performance.now() + this.cacheSeconds * 1000 };
    if (this.cache !== undefined) {
      const value = JSON.stringify({ fetchedAt, document: text });
      const written = await settleCache(
        () => this.cache?.set(cacheKey, value, this.cacheSeconds) ?? Promise.resolve(),
        signal,
      );
      if (!written.ok) safeLog(this.logger, 'warn', 'shared signing-key cache write failed', {});
    }
    safeLog(this.logger, 'info', `Signing keys fetched: reason=${reason}, keyCount=${String(document.keys.length)}.`, {
      reason,
      keyCount: document.keys.length,
    });
    safeCounter('anis.partners.signing_keys.fetches', { 'anis.fetch.reason': reason });
    return document;
  }
}

function isCacheEnvelope(value: unknown): value is { fetchedAt: number; document: string } {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.fetchedAt === 'number' &&
    Number.isSafeInteger(record.fetchedAt) &&
    typeof record.document === 'string'
  );
}

function settleCache<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<{ ok: true; value: T } | { ok: false }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { ok: true; value: T } | { ok: false }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => {
      finish({ ok: false });
    };
    const timer = setTimeout(() => {
      finish({ ok: false });
    }, 2_000);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve()
      .then(operation)
      .then(
        (value) => {
          finish({ ok: true, value });
        },
        () => {
          finish({ ok: false });
        },
      );
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A refused body cannot be used even when the host stream refuses cancellation.
  }
}

function abortReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError');
}
