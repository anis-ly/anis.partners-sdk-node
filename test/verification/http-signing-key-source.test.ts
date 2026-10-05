import { describe, expect, it, vi } from 'vitest';
import { HttpSigningKeySource, type KeyDocumentCache } from '../../src/verification/http-signing-key-source.js';

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

    await expect(source.get()).rejects.toMatchObject({ failure: 'content_digest_mismatch' });
  });
  it('does not follow redirects when retrieving the key document', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response('', { status: 302, headers: { Location: 'https://elsewhere.invalid' } })),
    );
    const source = new HttpSigningKeySource({ authority: 'https://partners.anis.ly', fetch });

    await expect(source.get()).rejects.toThrow('HTTP 302');
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
  });
});
