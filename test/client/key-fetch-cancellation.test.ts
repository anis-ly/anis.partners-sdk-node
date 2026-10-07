import { describe, expect, it } from 'vitest';
import { AnisPartnersClient } from '../../src/client.js';
import { AnisEnrollmentClient } from '../../src/enrollment/enrollment-client.js';
import { KeyedSigner } from '../../src/signing/keyed-signer.js';
import { signedFetchDouble } from '../support/signed-fetch.js';

const uuid = '2f1c8a94-6d37-4e52-b8a1-0c9e5d3f7b26';
const signer = new KeyedSigner({ sign: () => Promise.resolve(new Uint8Array(64)) }, uuid);

describe('signing-key fetch cancellation', () => {
  it('aborts promptly while a regular client fetches signing keys', async () => {
    const fetch = await fetchBlockedOnKeyDocument();
    const client = AnisPartnersClient.create({
      options: { authority: 'https://partners.example' },
      signer,
      fetch: fetch.fetcher,
    });
    const controller = new AbortController();

    const operation = client.orders.get(uuid, { signal: controller.signal });
    await fetch.keyRequestStarted;
    controller.abort();

    await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('aborts promptly while enrollment fetches signing keys', async () => {
    const fetch = await fetchBlockedOnKeyDocument();
    const client = AnisEnrollmentClient.create({
      authority: 'https://partners.example',
      invitationId: uuid,
      enrollmentToken: 'test-token',
      fetch: fetch.fetcher,
    });
    const controller = new AbortController();

    const operation = client.get({ signal: controller.signal });
    await fetch.keyRequestStarted;
    controller.abort();

    await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
  });
});

async function fetchBlockedOnKeyDocument(): Promise<{
  fetcher: typeof globalThis.fetch;
  keyRequestStarted: Promise<void>;
}> {
  const signed = await signedFetchDouble(() => ({ body: `{"id":"${uuid}","state":"pendingProof"}` }));
  let started: (() => void) | undefined;
  const keyRequestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const fetcher: typeof globalThis.fetch = async (resource, init = {}) => {
    const url = new URL(typeof resource === 'string' || resource instanceof URL ? resource : resource.url);
    if (url.pathname !== '/.well-known/partner-signing-keys.json') return signed.fetcher(resource, init);
    started?.();
    const signal = init.signal;
    return new Promise<Response>((_resolve, reject) => {
      const rejectOnAbort = () => {
        reject(signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'));
      };
      if (signal?.aborted) {
        rejectOnAbort();
      } else {
        signal?.addEventListener('abort', rejectOnAbort, { once: true });
      }
    });
  };
  return { fetcher, keyRequestStarted };
}
