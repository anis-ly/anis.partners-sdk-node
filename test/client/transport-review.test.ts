import { describe, expect, it, vi } from 'vitest';
import { AnisPartnersClient } from '../../src/client.js';
import { validateClientOptions } from '../../src/client-options.js';
import { PartnerTransport } from '../../src/operations/partner-transport.js';
import { KeyedSigner } from '../../src/signing/keyed-signer.js';
import { signedFetchDouble } from '../support/signed-fetch.js';

const keyId = 'b26bf827-8484-44aa-987a-b033e4cfa401';

describe('low-level transport security', () => {
  it('verifies a key-document route used for a profile path instead of accepting unsigned JSON', async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response('{"profile":"unsigned"}')));
    const transport = new PartnerTransport({
      ...validateClientOptions({ authority: 'https://partners.example' }),
      signer: new KeyedSigner({ sign: () => Promise.resolve(new Uint8Array(64)) }, keyId),
      fetcher,
      keySource: { get: () => Promise.resolve({ keys: [] }), refresh: () => Promise.resolve({ keys: [] }) },
    });

    await expect(
      transport.send({
        method: 'GET',
        route: '/.well-known/partner-signing-keys.json',
        path: '/v1/profile',
      }),
    ).rejects.toMatchObject({ failure: 'signature_missing' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('sends raw bytes without following a redirect', async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response('redirected', { status: 302, headers: { Location: '/elsewhere' } })),
    );
    const transport = new PartnerTransport({
      ...validateClientOptions({ authority: 'https://partners.example' }),
      signer: new KeyedSigner({ sign: () => Promise.resolve(new Uint8Array(64)) }, keyId),
      fetcher,
      keySource: { get: () => Promise.resolve({ keys: [] }), refresh: () => Promise.resolve({ keys: [] }) },
    });

    await expect(
      transport.send({ method: 'GET', route: '/v1/profile', path: '/v1/profile', profile: 'SafeRead' }),
    ).rejects.toMatchObject({ failure: 'signature_missing' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const init = fetcher.mock.calls[0]?.[1];
    expect(init?.redirect).toBe('manual');
    expect(new Headers(init?.headers).get('accept-encoding')).toBe('identity');
  });

  it('preserves identity encoding and manual redirects on the client key-document fetch', async () => {
    const fake = await signedFetchDouble(() => ({
      body: '{"id":"2f1c8a94-6d37-4e52-b8a1-0c9e5d3f7b26","name":"Main","currency":"LYD","balance":{"amount":"1.000","currency":"LYD"}}',
    }));
    const calls: RequestInit[] = [];
    const fetcher: typeof globalThis.fetch = (resource, init) => {
      calls.push(init ?? {});
      return fake.fetcher(resource, init);
    };
    const client = AnisPartnersClient.create({
      options: { authority: 'https://partners.example' },
      signer: new KeyedSigner({ sign: () => Promise.resolve(new Uint8Array(64)) }, keyId),
      fetch: fetcher,
    });

    await client.wallets.get('2f1c8a94-6d37-4e52-b8a1-0c9e5d3f7b26');

    expect(calls).toHaveLength(2);
    expect(calls[0]?.redirect).toBe('manual');
    expect(new Headers(calls[0]?.headers).get('accept-encoding')).toBe('identity');
  });
});
