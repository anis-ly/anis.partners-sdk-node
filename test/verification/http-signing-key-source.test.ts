import { describe, expect, it, vi } from 'vitest';
import { HttpSigningKeySource, type KeyDocumentCache } from '../../src/verification/http-signing-key-source.js';
import { SigningKeyDocumentUnavailableError } from '../../src/errors/signing-key-document-unavailable-error.js';
import { InMemoryTelemetry } from '../support/telemetry.js';

const document = JSON.stringify({
  keys: [
    {
      kty: 'EC',
      crv: 'P-256',
      x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      y: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      kid: 'active',
    },
  ],
});
const response = (): Response =>
  new Response(document, { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('HTTP signing-key source', () => {
  it('uses the cached document within its TTL', async () => {
    const fetch = vi.fn(() => Promise.resolve(response()));
    const source = new HttpSigningKeySource({ authority: 'https://partners.anis.ly', fetch });
    await source.get();
    await source.get();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('requests the key document with identity encoding and manual redirects', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(response()));
    const source = new HttpSigningKeySource({ authority: 'https://partners.anis.ly', fetch });

    await source.get();

    const init = fetch.mock.calls[0]?.[1];
    expect(init?.redirect).toBe('manual');
    expect(new Headers(init?.headers).get('accept-encoding')).toBe('identity');
  });
  it('refuses an encoded key document before parsing it', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response(document, { status: 200, headers: { 'Content-Encoding': 'gzip' } })),
    );
    const source = new HttpSigningKeySource({ authority: 'https://partners.anis.ly', fetch });

    await expect(source.get()).rejects.toBeInstanceOf(SigningKeyDocumentUnavailableError);
  });
  it('does not follow redirects when retrieving the key document', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response('', { status: 302, headers: { Location: 'https://elsewhere.invalid' } })),
    );
    const source = new HttpSigningKeySource({ authority: 'https://partners.anis.ly', fetch });

    await expect(source.get()).rejects.toBeInstanceOf(SigningKeyDocumentUnavailableError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe('manual');
  });
  it('fetches again after TTL expiry', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(() => Promise.resolve(response()));
      const source = new HttpSigningKeySource({ authority: 'https://partners.anis.ly', cacheSeconds: 1, fetch });
      await source.get();
      await vi.advanceTimersByTimeAsync(1001);
      await source.get();
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it('always fetches when refresh is requested', async () => {
    const fetch = vi.fn(() => Promise.resolve(response()));
    const source = new HttpSigningKeySource({ authority: 'https://partners.anis.ly', fetch });
    await source.get();
    await source.refresh();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('shares one fetch among concurrent first callers', async () => {
    let release: ((response: Response) => void) | undefined;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const source = new HttpSigningKeySource({ authority: 'https://partners.anis.ly', fetch });
    const first = source.get();
    const second = source.get();
    expect(fetch).toHaveBeenCalledTimes(1);
    release?.(response());
    await Promise.all([first, second]);
  });
  it('uses a shared document cache across source instances', async () => {
    const values = new Map<string, string>();
    const cache: KeyDocumentCache = {
      get: (key) => Promise.resolve(values.get(key)),
      set: (key, value) => {
        values.set(key, value);
        return Promise.resolve();
      },
    };
    const firstFetch = vi.fn(() => Promise.resolve(response()));
    const secondFetch = vi.fn(() => Promise.resolve(response()));
    await new HttpSigningKeySource({
      authority: 'https://partners.anis.ly',
      fetch: firstFetch,
      documentCache: cache,
    }).get();
    await new HttpSigningKeySource({
      authority: 'https://partners.anis.ly',
      fetch: secondFetch,
      documentCache: cache,
    }).get();
    expect(firstFetch).toHaveBeenCalledTimes(1);
    expect(secondFetch).not.toHaveBeenCalled();
    const stored = values.values().next().value;
    expect(stored).toBeDefined();
    const envelope = JSON.parse(stored ?? '{}') as unknown;
    if (typeof envelope !== 'object' || envelope === null) throw new TypeError('The shared cache envelope is invalid.');
    expect(Object.keys(envelope).sort()).toEqual(['document', 'fetchedAt']);
    const record = envelope as Record<string, unknown>;
    expect(record.document).toBe(document);
    const fetchedAt = record.fetchedAt;
    expect(typeof fetchedAt).toBe('number');
    if (typeof fetchedAt === 'number') expect(Number.isSafeInteger(fetchedAt)).toBe(true);
  });

  it('logs and counts only actual fetches when reading a shared-cache hit', async () => {
    const telemetry = new InMemoryTelemetry();
    const values = new Map<string, string>();
    const cache: KeyDocumentCache = {
      get: (key) => Promise.resolve(values.get(key)),
      set: (key, value) => {
        values.set(key, value);
        return Promise.resolve();
      },
    };
    const messages: { message: string; fields: Record<string, unknown> }[] = [];
    const firstFetch = vi.fn(() => Promise.resolve(response()));
    const secondFetch = vi.fn(() => Promise.resolve(response()));

    await new HttpSigningKeySource({
      authority: 'https://partners.anis.ly',
      fetch: firstFetch,
      documentCache: cache,
    }).get();
    const measurementsBeforeHit = telemetry.measurements.length;
    await new HttpSigningKeySource({
      authority: 'https://partners.anis.ly',
      fetch: secondFetch,
      documentCache: cache,
      logger: {
        debug: (message, fields) => messages.push({ message, fields }),
        info: (message, fields) => messages.push({ message, fields }),
      },
    }).get();

    expect(secondFetch).not.toHaveBeenCalled();
    expect(messages).toEqual([{ message: 'signing keys read from the shared cache', fields: {} }]);
    expect(
      telemetry.measurements
        .slice(measurementsBeforeHit)
        .some((measurement) => measurement.instrument.endsWith('signing_keys.fetches')),
    ).toBe(false);
  });

  it('treats a throwing shared-cache read as a miss', async () => {
    const cache: KeyDocumentCache = {
      get: () => Promise.reject(new Error('cache unavailable')),
      set: () => Promise.resolve(),
    };
    const fetch = vi.fn(() => Promise.resolve(response()));
    await new HttpSigningKeySource({ authority: 'https://partners.anis.ly', fetch, documentCache: cache }).get();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('ignores a shared-cache write failure after fetching the document', async () => {
    const cache: KeyDocumentCache = {
      get: () => Promise.resolve(undefined),
      set: () => Promise.reject(new Error('cache unavailable')),
    };
    const fetch = vi.fn(() => Promise.resolve(response()));
    await expect(
      new HttpSigningKeySource({ authority: 'https://partners.anis.ly', fetch, documentCache: cache }).get(),
    ).resolves.toMatchObject({ keys: [{ kid: 'active' }] });
  });

  it('refetches a shared entry whose fetch time is stale or too far in the future', async () => {
    const values = new Map<string, string>();
    const key = 'anis_partners_keys_';
    const cache: KeyDocumentCache = {
      get: (cacheKey) => Promise.resolve(values.get(cacheKey)),
      set: (cacheKey, value) => {
        values.set(cacheKey, value);
        return Promise.resolve();
      },
    };
    const firstFetch = vi.fn(() => Promise.resolve(response()));
    const secondFetch = vi.fn(() => Promise.resolve(response()));
    await new HttpSigningKeySource({
      authority: 'https://partners.anis.ly',
      fetch: firstFetch,
      documentCache: cache,
    }).get();
    const [cacheKey] = values.keys();
    expect(cacheKey?.startsWith(key)).toBe(true);
    values.set(cacheKey ?? '', JSON.stringify({ fetchedAt: Math.floor(Date.now() / 1000) + 61, document }));
    await new HttpSigningKeySource({
      authority: 'https://partners.anis.ly',
      fetch: secondFetch,
      documentCache: cache,
    }).get();
    expect(secondFetch).toHaveBeenCalledTimes(1);
  });

  it('expires a shared hit at the original fetch time plus its TTL', async () => {
    vi.useFakeTimers();
    try {
      const values = new Map<string, string>();
      const cache: KeyDocumentCache = {
        get: (cacheKey) => Promise.resolve(values.get(cacheKey)),
        set: (cacheKey, value) => {
          values.set(cacheKey, value);
          return Promise.resolve();
        },
      };
      const originalFetch = vi.fn(() => Promise.resolve(response()));
      const laterFetch = vi.fn(() => Promise.resolve(response()));
      await new HttpSigningKeySource({
        authority: 'https://partners.anis.ly',
        cacheSeconds: 1,
        fetch: originalFetch,
        documentCache: cache,
      }).get();
      await vi.advanceTimersByTimeAsync(800);
      const source = new HttpSigningKeySource({
        authority: 'https://partners.anis.ly',
        cacheSeconds: 1,
        fetch: laterFetch,
        documentCache: cache,
      });
      await source.get();
      await vi.advanceTimersByTimeAsync(250);
      await source.get();
      expect(laterFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a shared-cache hook that hangs for two seconds as a miss', async () => {
    vi.useFakeTimers();
    try {
      const cache: KeyDocumentCache = {
        get: () => new Promise<string | undefined>(() => undefined),
        set: () => Promise.resolve(),
      };
      const fetch = vi.fn(() => Promise.resolve(response()));
      const result = new HttpSigningKeySource({
        authority: 'https://partners.anis.ly',
        fetch,
        documentCache: cache,
      }).get();
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(result).resolves.toMatchObject({ keys: [{ kid: 'active' }] });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the fetched document when a shared-cache write hangs for two seconds', async () => {
    vi.useFakeTimers();
    try {
      const cache: KeyDocumentCache = {
        get: () => Promise.resolve(undefined),
        set: () => new Promise<void>(() => undefined),
      };
      const fetch = vi.fn(() => Promise.resolve(response()));
      const source = new HttpSigningKeySource({ authority: 'https://partners.anis.ly', fetch, documentCache: cache });
      const result = source.get();
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(result).resolves.toMatchObject({ keys: [{ kid: 'active' }] });
      await expect(source.get()).resolves.toMatchObject({ keys: [{ kid: 'active' }] });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears an aborted sole waiter flight before the next caller arrives', async () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      const cache: KeyDocumentCache = {
        get: () => {
          reads += 1;
          return new Promise<string | undefined>(() => undefined);
        },
        set: () => Promise.resolve(),
      };
      const fetch = vi.fn(() => Promise.resolve(response()));
      const source = new HttpSigningKeySource({ authority: 'https://partners.anis.ly', fetch, documentCache: cache });
      const controller = new AbortController();
      const first = source.get({ signal: controller.signal });
      controller.abort(new DOMException('Canceled', 'AbortError'));
      await expect(first).rejects.toMatchObject({ name: 'AbortError' });
      const next = source.get();
      await Promise.resolve();
      await Promise.resolve();
      expect(reads).toBe(2);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(next).resolves.toMatchObject({ keys: [{ kid: 'active' }] });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
