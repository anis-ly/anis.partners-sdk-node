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
  it.each(['http://keys.example.ly', 'http://localhost.example.ly', 'http://10.0.0.1', 'ftp://keys.example.ly'])(
    'rejects insecure key authority %s before fetching',
    (authority) => {
      const fetch = vi.fn<typeof globalThis.fetch>();
      expect(() => new HttpSigningKeySource({ authority, fetch })).toThrow(/must use HTTPS/);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it.each(['http://localhost:7000', 'http://127.0.0.1:7000', 'http://[::1]:7000'])(
    'accepts loopback key authority %s for local testing',
    async (authority) => {
      const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(response()));
      const source = new HttpSigningKeySource({ authority, fetch });
      await source.get();
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it('accepts HTTPS URL objects and does not retain a mutable caller URL', async () => {
    const authority = new URL('https://keys.example.ly');
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(response()));
    const source = new HttpSigningKeySource({ authority, fetch });
    authority.protocol = 'http:';
    await source.get();
    expect(fetch.mock.calls[0]?.[0]).toEqual(new URL('https://keys.example.ly/.well-known/partner-signing-keys.json'));
  });
  it('refuses a cache lifetime longer than five minutes', () => {
    expect(() => new HttpSigningKeySource({ authority: 'https://partners.anis.ly', cacheSeconds: 301 })).toThrow(
      RangeError,
    );
    expect(() => new HttpSigningKeySource({ authority: 'https://partners.anis.ly', cacheSeconds: 300 })).not.toThrow();
  });
  it('keeps a fetched document for five minutes by default', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(response()));
      const source = new HttpSigningKeySource({ authority: 'https://partners.anis.ly', fetch });
      await source.get();
      await vi.advanceTimersByTimeAsync(299_999);
      await source.get();
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2);
      await source.get();
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it('expires a shared entry five minutes after its original fetch', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T12:00:00Z'));
    try {
      let stored = JSON.stringify({ fetchedAt: Date.now() / 1000 - 299, document });
      const cache: KeyDocumentCache = {
        get: () => Promise.resolve(stored),
        set: () => Promise.resolve(),
      };
      const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(response()));
      const source = new HttpSigningKeySource({ authority: 'https://partners.anis.ly', fetch, documentCache: cache });
      await source.get();
      expect(fetch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_001);
      await source.get();
      expect(fetch).toHaveBeenCalledTimes(1);
      stored = JSON.stringify({ fetchedAt: Math.floor(Date.now() / 1000) - 300, document });
      await new HttpSigningKeySource({ authority: 'https://partners.anis.ly', fetch, documentCache: cache }).get();
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it('caps a shared entry with a future fetch time at five minutes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T12:00:00Z'));
    try {
      const stored = JSON.stringify({ fetchedAt: Date.now() / 1000 + 60, document });
      const cache: KeyDocumentCache = {
        get: () => Promise.resolve(stored),
        set: () => Promise.resolve(),
      };
      const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(response()));
      const source = new HttpSigningKeySource({ authority: 'https://partners.anis.ly', fetch, documentCache: cache });

      await source.get();
      expect(fetch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(299_999);
      await source.get();
      expect(fetch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await source.get();
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refetches for an unknown key at most once per thirty seconds, counting a failed fetch', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi
        .fn(() => Promise.resolve(response()))
        .mockImplementationOnce(() => Promise.resolve(response()))
        .mockImplementationOnce(() => Promise.resolve(new Response('', { status: 503 })));
      const source = new HttpSigningKeySource({ authority: 'https://partners.anis.ly', fetch });
      const held = await source.get();
      await expect(source.refresh()).rejects.toBeInstanceOf(SigningKeyDocumentUnavailableError);
      await expect(source.refresh()).resolves.toBe(held);
      expect(fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(29_999);
      await expect(source.refresh()).resolves.toBe(held);
      expect(fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      await source.refresh();
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
  it('shares one unknown-key refetch among concurrent callers', async () => {
    let release: ((response: Response) => void) | undefined;
    const fetch = vi
      .fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      )
      .mockImplementationOnce(() => Promise.resolve(response()));
    const source = new HttpSigningKeySource({ authority: 'https://partners.anis.ly', fetch });
    await source.get();
    const first = source.refresh();
    const second = source.refresh();
    expect(fetch).toHaveBeenCalledTimes(2);
    release?.(response());
    const [firstDocument, secondDocument] = await Promise.all([first, second]);
    expect(firstDocument).toBe(secondDocument);
  });
  it('rejects every concurrent unknown-key refresh caller when the shared fetch fails', async () => {
    let release: ((response: Response) => void) | undefined;
    const fetch = vi
      .fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      )
      .mockImplementationOnce(() => Promise.resolve(response()));
    const source = new HttpSigningKeySource({ authority: 'https://partners.anis.ly', fetch });
    const held = await source.get();
    const first = source.refresh();
    const second = source.refresh();
    const results = Promise.allSettled([first, second]);

    expect(fetch).toHaveBeenCalledTimes(2);
    release?.(new Response('', { status: 503 }));
    for (const result of await results) {
      expect(result.status).toBe('rejected');
      if (result.status !== 'rejected') throw new TypeError('Expected a refused refresh.');
      expect(result.reason).toBeInstanceOf(SigningKeyDocumentUnavailableError);
    }
    await expect(source.refresh()).resolves.toBe(held);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('counts an aborted unknown-key fetch towards the cooldown', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>(
        (_resource, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => {
                reject(new DOMException('Canceled', 'AbortError'));
              },
              {
                once: true,
              },
            );
          }),
      )
      .mockImplementationOnce(() => Promise.resolve(response()));
    const source = new HttpSigningKeySource({ authority: 'https://partners.anis.ly', fetch });
    const held = await source.get();
    const controller = new AbortController();
    const pending = source.refresh({ signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(source.refresh()).resolves.toBe(held);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('uses the cached document within its TTL', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(response()));
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
      const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(response()));
      const source = new HttpSigningKeySource({ authority: 'https://partners.anis.ly', cacheSeconds: 1, fetch });
      await source.get();
      await vi.advanceTimersByTimeAsync(1001);
      await source.get();
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it('fetches when the first unknown-key refresh is requested', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(response()));
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
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(response()));
    await new HttpSigningKeySource({ authority: 'https://partners.anis.ly', fetch, documentCache: cache }).get();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('ignores a shared-cache write failure after fetching the document', async () => {
    const cache: KeyDocumentCache = {
      get: () => Promise.resolve(undefined),
      set: () => Promise.reject(new Error('cache unavailable')),
    };
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(response()));
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
      const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(response()));
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
      const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(response()));
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
      const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(response()));
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

describe('HTTP signing-key purpose preservation', () => {
  it('preserves purpose through HTTP, memory, refresh and shared-cache round trips', async () => {
    const keyDocument = JSON.stringify({ keys: [{ kid: 'webhook/exact', purpose: 'webhook' }] });
    let stored: string | undefined;
    const cache: KeyDocumentCache = {
      get: () => Promise.resolve(stored),
      set: (_key, value) => {
        stored = value;
        return Promise.resolve();
      },
    };
    const fetch = vi.fn(() => Promise.resolve(new Response(keyDocument)));
    const options = { authority: 'https://partners.anis.ly', fetch, documentCache: cache };
    const source = new HttpSigningKeySource(options);
    const fetched = await source.get();
    expect(fetched.keys[0]).toMatchObject({ purpose: 'webhook' });
    expect(await source.get()).toBe(fetched);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await source.refresh()).keys[0]).toMatchObject({ purpose: 'webhook' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await new HttpSigningKeySource(options).get()).keys[0]).toMatchObject({ purpose: 'webhook' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
