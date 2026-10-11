import { describe, expect, it } from 'vitest';
import { AnisPartnersClient } from '../../src/client.js';
import { KeyedSigner } from '../../src/signing/keyed-signer.js';
import { signedFetchDouble } from '../support/signed-fetch.js';

const id = '2f1c8a94-6d37-4e52-b8a1-0c9e5d3f7b26';
const signer = new KeyedSigner({ sign: () => Promise.resolve(new Uint8Array(64)) }, id);
const client = (fetch: typeof globalThis.fetch) =>
  AnisPartnersClient.create({ options: { authority: 'https://partners.example' }, signer, fetch });

describe('access stop and catalogue card routes', () => {
  it.each(['suspend', 'revoke'] as const)('signs and verifies %s with a reason body', async (kind) => {
    const fake = await signedFetchDouble(() => ({
      body: JSON.stringify(
        kind === 'suspend'
          ? { applicationId: id, status: 'suspended', suspendedAt: '2026-10-11T09:00:00Z' }
          : { keyId: id, status: 'revoked', revokedAt: '2026-10-11T09:00:00Z' },
      ),
    }));
    const api = client(fake.fetcher);
    const result =
      kind === 'suspend'
        ? await api.access.suspendApplication('  incident  ')
        : await api.access.revokeKey(id, '  incident  ');
    expect(result.status).toBe(kind === 'suspend' ? 'suspended' : 'revoked');
    const request = fake.requests[0];
    expect(request?.url.pathname).toBe(kind === 'suspend' ? '/v1/application/suspend' : `/v1/keys/${id}/revoke`);
    expect(new TextDecoder().decode(request?.body)).toBe('{"reason":"incident"}');
    const headers = new Headers(request?.init.headers);
    expect(headers.get('Signature-Input')).toContain(
      '("@method" "@authority" "@path" "@query" "content-digest" "nonce" "x-anis-date")',
    );
    expect(headers.has('Idempotency-Key')).toBe(false);
    expect(headers.get('Content-Type')).toBe('application/json');
  });
  it.each(['', '   ', 'x'.repeat(501)])('refuses invalid reason before sending', async (reason) => {
    const fake = await signedFetchDouble(() => ({}));
    await expect(client(fake.fetcher).access.suspendApplication(reason)).rejects.toThrow(/Reason/);
    await expect(client(fake.fetcher).access.revokeKey(id, reason)).rejects.toThrow(/Reason/);
    expect(fake.requests).toHaveLength(0);
  });
  it('reads one catalogue card without requiring a response signature', async () => {
    const paths: string[] = [];
    const api = client((resource) => {
      paths.push(typeof resource === 'string' || resource instanceof URL ? resource.toString() : resource.url);
      return Promise.resolve(
        new Response(
          JSON.stringify({ id, logo: 'https://assets.example/card.png', category: { id, name: { en: 'Games' } } }),
        ),
      );
    });
    expect(await api.catalogue.getCard(id, id)).toMatchObject({
      id,
      logo: 'https://assets.example/card.png',
      category: { id, name: { en: 'Games' } },
    });
    expect(paths).toEqual([`https://partners.example/v1/wallets/${id}/catalog/cards/${id}`]);
  });
});
