import { describe, expect, it, vi } from 'vitest';
import { AnisPartnersClient } from '../../src/client.js';
import { AnisApiError } from '../../src/errors/anis-api-error.js';
import { MalformedResponseError } from '../../src/errors/malformed-response-error.js';
import { Money } from '../../src/models/money.js';
import { RequestSigningError } from '../../src/signing/request-signing-error.js';
import { signedFetchDouble } from '../support/signed-fetch.js';
import { publicFixture } from '../models/product-fixtures.js';
import {
  accepted,
  clientFor,
  endpoint,
  eventAccepted,
  eventId,
  meterId,
  meterIntent,
  rechargeId,
  rechargeIntent,
  signer,
  walletId,
} from '../operations/product-test-support.js';

type ProductCall = (client: AnisPartnersClient) => Promise<unknown>;
const calls: {
  name: string;
  call: ProductCall;
  body: unknown;
  purchase: boolean;
  status?: number;
  headers?: HeadersInit;
}[] = [
  {
    name: 'meter create',
    call: (client) => client.meterCharges.create(walletId, meterId, meterIntent),
    body: accepted('meterCharge', meterId),
    purchase: true,
  },
  {
    name: 'direct recharge create',
    call: (client) => client.directRecharges.create(walletId, rechargeId, rechargeIntent),
    body: accepted('directRecharge', rechargeId),
    purchase: true,
  },
  {
    name: 'recipient update',
    call: (client) => client.directRecharges.updateRecipient(rechargeId, { recipient: rechargeIntent.recipient }),
    body: accepted('directRecharge', rechargeId),
    status: 202,
    headers: { Location: `/v1/direct-recharges/${rechargeId}` },
    purchase: false,
  },
  {
    name: 'endpoint set',
    call: (client) => client.webhookEndpoint.set({ url: endpoint.url }),
    body: endpoint,
    purchase: false,
  },
  { name: 'endpoint test', call: (client) => client.webhookEndpoint.test(), body: eventAccepted, purchase: false },
  {
    name: 'event redeliver',
    call: (client) => client.webhookEvents.redeliver(eventId),
    body: eventAccepted,
    purchase: false,
  },
];

describe('product signed answers', () => {
  it.each(calls)(
    'accepts a signed success and typed signed refusal on $name',
    async ({ call, body, purchase, status, headers }) => {
      let refused = false;
      const fake = await signedFetchDouble(() => ({
        status: refused ? 422 : (status ?? (purchase ? 202 : 200)),
        ...(refused || headers === undefined ? {} : { headers }),
        body: JSON.stringify(refused ? { status: 422, code: 'validation_failed' } : body),
      }));
      const client = clientFor(fake.fetcher);
      await expect(call(client)).resolves.toBeDefined();
      refused = true;
      if (purchase)
        await expect(call(client)).resolves.toMatchObject({
          kind: 'notPlaced',
          refusal: { code: 'validation_failed' },
        });
      else await expect(call(client)).rejects.toBeInstanceOf(AnisApiError);
      expect(fake.requests).toHaveLength(2);
      const nonces = fake.requests.map((request) => new Headers(request.init.headers).get('Nonce'));
      expect(nonces[0]).not.toBe(nonces[1]);
    },
  );
  for (const corrupt of ['missing', 'bad'] as const) {
    it.each(calls)(
      `discards a ${corrupt} answer signature on $name for success and refusal`,
      async ({ call, body, purchase, status, headers }) => {
        for (const refusal of [false, true]) {
          const fake = await signedFetchDouble(() => ({
            status: refusal ? 422 : (status ?? (purchase ? 202 : 200)),
            ...(refusal || headers === undefined ? {} : { headers }),
            body: JSON.stringify(refusal ? { status: 422, code: 'validation_failed' } : body),
          }));
          const fetcher: typeof globalThis.fetch = async (resource, init) => {
            const response = await fake.fetcher(resource, init);
            const url = new URL(typeof resource === 'string' || resource instanceof URL ? resource : resource.url);
            if (url.pathname.startsWith('/.well-known/')) return response;
            const headers = new Headers(response.headers);
            if (corrupt === 'missing') {
              headers.delete('Signature');
              headers.delete('Signature-Input');
            } else headers.set('Signature', `sig1=:${Buffer.from(new Uint8Array(64)).toString('base64')}:`);
            return new Response(await response.arrayBuffer(), { status: response.status, headers });
          };
          const client = clientFor(fetcher);
          const failure = corrupt === 'missing' ? 'signature_missing' : 'signature_invalid';
          if (purchase) await expect(call(client)).resolves.toMatchObject({ kind: 'unknown', cause: { failure } });
          else await expect(call(client)).rejects.toMatchObject({ failure });
          expect(fake.requests).toHaveLength(1);
        }
      },
    );
  }
  it.each([
    {
      name: 'meter',
      call: (client: AnisPartnersClient) => client.meterCharges.create(walletId, meterId, meterIntent),
      wire: publicFixture('meter-succeeded'),
      operationId: meterId,
    },
    {
      name: 'direct recharge',
      call: (client: AnisPartnersClient) => client.directRecharges.create(walletId, rechargeId, rechargeIntent),
      wire: publicFixture('circle-completed'),
      operationId: rechargeId,
    },
  ])('keeps a mismatched signed full $name create unresolved', async ({ call, wire, operationId }) => {
    const fake = await signedFetchDouble(() => ({ body: JSON.stringify({ ...wire, operationId: walletId }) }));
    const result = await call(clientFor(fake.fetcher));
    expect(result).toMatchObject({ kind: 'unknown', operationId });
    if (result.kind !== 'unknown') throw new Error('Expected unknown');
    expect(result.cause).toBeInstanceOf(MalformedResponseError);
  });
  it('keeps key-fetch failure unresolved with the original operation id', async () => {
    const fake = await signedFetchDouble(() => ({
      status: 202,
      body: JSON.stringify(accepted('meterCharge', meterId)),
    }));
    const client = clientFor((resource, init) => {
      const url = new URL(typeof resource === 'string' || resource instanceof URL ? resource : resource.url);
      return url.pathname.startsWith('/.well-known/')
        ? Promise.reject(new Error('Key source unavailable'))
        : fake.fetcher(resource, init);
    });
    expect(await client.meterCharges.create(walletId, meterId, meterIntent)).toMatchObject({
      kind: 'unknown',
      operationId: meterId,
    });
    expect(fake.requests).toHaveLength(1);
  });
  it('wraps request projection failure before sending', async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>();
    const request = {
      ...meterIntent,
      get externalReference(): string {
        throw new Error('Cannot encode');
      },
    };
    await expect(clientFor(fetcher).meterCharges.create(walletId, meterId, request)).rejects.toBeInstanceOf(
      RequestSigningError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('projects exact product Money without calling its timestamp-bearing serializer', async () => {
    const total = Money.of('97.500', 'LYD', new Date('2026-10-20T00:00:00Z'));
    const serialize = vi.spyOn(total, 'toJSON').mockImplementation(() => {
      throw new Error('Must project amount and currency');
    });
    const fake = await signedFetchDouble(() => ({
      status: 202,
      body: JSON.stringify(accepted('meterCharge', meterId)),
    }));
    try {
      const result = await clientFor(fake.fetcher).meterCharges.create(walletId, meterId, {
        ...meterIntent,
        expectedTotal: total,
      });
      expect(result.kind).toBe('processing');
      expect(serialize).not.toHaveBeenCalled();
      expect(fake.requests).toHaveLength(1);
      expect(JSON.parse(new TextDecoder().decode(fake.requests[0]?.body))).toEqual({
        packageId: meterIntent.packageId,
        meterNumber: meterIntent.meterNumber,
        expectedTotal: { amount: '97.500', currency: 'LYD' },
        externalReference: meterIntent.externalReference,
      });
    } finally {
      serialize.mockRestore();
    }
  });
  it('preserves caller cancellation and signer rejection for direct recharge creates', async () => {
    const stop = new Error('Stopped');
    const controller = new AbortController();
    controller.abort(stop);
    const fetcher = vi.fn<typeof globalThis.fetch>(() => Promise.reject(stop));
    await expect(
      clientFor(fetcher).directRecharges.create(walletId, rechargeId, rechargeIntent, { signal: controller.signal }),
    ).rejects.toBe(stop);
    const noSend = vi.fn<typeof globalThis.fetch>();
    const client = AnisPartnersClient.create({
      options: { authority: 'https://partners.example' },
      signer: { keyId: signer.keyId, sign: () => Promise.reject(stop) },
      fetch: noSend,
    });
    await expect(client.directRecharges.create(walletId, rechargeId, rechargeIntent)).rejects.toBeInstanceOf(
      RequestSigningError,
    );
    expect(noSend).not.toHaveBeenCalled();
  });
});
