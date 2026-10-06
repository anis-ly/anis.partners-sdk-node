import { describe, expect, it } from 'vitest';
import { AnisEnrollmentClient } from '../../src/enrollment/enrollment-client.js';
import { AnisPartnersClient } from '../../src/client.js';
import { Money } from '../../src/models/money.js';
import type { PartnerLogger } from '../../src/observability/logger.js';
import { KeyedSigner } from '../../src/signing/keyed-signer.js';
import { signedFetchDouble } from '../support/signed-fetch.js';
import { InMemoryTelemetry } from '../support/telemetry.js';

const id = '2f1c8a94-6d37-4e52-b8a1-0c9e5d3f7b26';
const orderId = 'b26bf827-8484-44aa-987a-b033e4cfa401';
const soldCardId = '6e5b2d70-4416-4a6e-900a-5528803a6a7d';
const signer = new KeyedSigner({ sign: () => Promise.resolve(new Uint8Array(64)) }, id);
const telemetry = new InMemoryTelemetry();

describe('telemetry isolation', () => {
  it('keeps reads, reveals, orders, refusals, and enrollment unchanged when the tracer and meter throw', async () => {
    telemetry.failSpanStart = true;
    telemetry.failMeasurements = true;
    const readFetch = await signedFetchDouble(() => ({
      body: `{"id":"${id}","name":"Main","currency":"LYD","balance":{"amount":"1.000","currency":"LYD"}}`,
    }));
    const revealFetch = await signedFetchDouble(() => ({ body: `{"soldCardId":"${soldCardId}","voucher":"code"}` }));
    const completeFetch = await signedFetchDouble(() => ({
      status: 201,
      body: `{"operationId":"${orderId}","status":"completed","soldCards":[]}`,
    }));
    const unknownFetch = await signedFetchDouble(() => ({ body: '{}' }));
    const unknownFetcher: typeof globalThis.fetch = async (resource, init) => {
      const url = new URL(typeof resource === 'string' || resource instanceof URL ? resource : resource.url);
      if (url.pathname === '/.well-known/partner-signing-keys.json') return unknownFetch.fetcher(resource, init);
      throw new TypeError('network unavailable');
    };
    const refusalFetch = await signedFetchDouble(() => ({
      status: 404,
      body: '{"status":404,"code":"resource_not_found"}',
    }));
    const enrollmentFetch = await signedFetchDouble(() => ({ body: '{}' }));

    try {
      const read = await AnisPartnersClient.create({
        options: { authority: 'https://partners.example' },
        signer,
        fetch: readFetch.fetcher,
      }).wallets.get(id);
      const reveal = await AnisPartnersClient.create({
        options: { authority: 'https://partners.example' },
        signer,
        fetch: revealFetch.fetcher,
      }).ownedCards.reveal(id, soldCardId);
      const createOrder = (fetch: typeof globalThis.fetch) =>
        AnisPartnersClient.create({ options: { authority: 'https://partners.example' }, signer, fetch }).orders.create(
          id,
          orderId,
          {
            cardId: id,
            quantity: 1,
            expectedUnitPrice: Money.of('1.000', 'LYD'),
            expectedTotal: Money.of('1.000', 'LYD'),
          },
        );
      const completed = await createOrder(completeFetch.fetcher);
      const unknown = await createOrder(unknownFetcher);
      const refusalClient = AnisPartnersClient.create({
        options: { authority: 'https://partners.example' },
        signer,
        fetch: refusalFetch.fetcher,
      });
      await expect(refusalClient.wallets.get(id)).rejects.toMatchObject({ code: 'resource_not_found' });
      const enrollment = AnisEnrollmentClient.create({
        authority: 'https://partners.example',
        invitationId: id,
        enrollmentToken: 'token',
        fetch: enrollmentFetch.fetcher,
      });

      expect(read.id).toBe(id);
      expect(reveal.voucher).toBe('code');
      expect(completed.kind).toBe('completed');
      expect(unknown.kind).toBe('unknown');
      await expect(enrollment.getStatus()).resolves.toBeDefined();
    } finally {
      telemetry.failSpanStart = false;
      telemetry.failMeasurements = false;
    }
  });

  it('isolates an asynchronously rejecting logger across reads, reveals, orders, enrollment, and key fetches', async () => {
    let loggerCalls = 0;
    let keyFetchLogCalls = 0;
    const rejectLog = (message: string, fields: Record<string, unknown>): Promise<void> => {
      loggerCalls += 1;
      if (fields.eventId === 1005) keyFetchLogCalls += 1;
      return Promise.reject(new Error(`logger unavailable at ${message}`));
    };
    const logger: PartnerLogger = {
      debug: rejectLog,
      info: rejectLog,
      warn: rejectLog,
      error: rejectLog,
    };
    const readFetch = await signedFetchDouble(() => ({
      body: `{"id":"${id}","name":"Main","currency":"LYD","balance":{"amount":"1.000","currency":"LYD"}}`,
    }));
    const revealFetch = await signedFetchDouble(() => ({ body: `{"soldCardId":"${soldCardId}","voucher":"code"}` }));
    const completedFetch = await signedFetchDouble(() => ({
      status: 201,
      body: `{"operationId":"${orderId}","status":"completed","soldCards":[]}`,
    }));
    const unknownKeys = await signedFetchDouble(() => ({ body: '{}' }));
    const unknownFetcher: typeof globalThis.fetch = async (resource, init) => {
      const url = new URL(typeof resource === 'string' || resource instanceof URL ? resource : resource.url);
      if (url.pathname === '/.well-known/partner-signing-keys.json') return unknownKeys.fetcher(resource, init);
      throw new TypeError('network unavailable');
    };
    const enrollmentFetch = await signedFetchDouble(() => ({ body: '{"state":"pendingProof"}' }));

    const readClient = AnisPartnersClient.create({
      options: { authority: 'https://partners.example' },
      signer,
      fetch: readFetch.fetcher,
      logger,
    });
    await expect(readClient.wallets.get(id)).resolves.toMatchObject({ id });
    const revealClient = AnisPartnersClient.create({
      options: { authority: 'https://partners.example' },
      signer,
      fetch: revealFetch.fetcher,
      logger,
    });
    await expect(revealClient.ownedCards.reveal(id, soldCardId)).resolves.toMatchObject({ voucher: 'code' });
    const createOrder = (fetch: typeof globalThis.fetch) =>
      AnisPartnersClient.create({
        options: { authority: 'https://partners.example' },
        signer,
        fetch,
        logger,
      }).orders.create(id, orderId, {
        cardId: id,
        quantity: 1,
        expectedUnitPrice: Money.of('1.000', 'LYD'),
        expectedTotal: Money.of('1.000', 'LYD'),
      });
    await expect(createOrder(completedFetch.fetcher)).resolves.toMatchObject({ kind: 'completed' });
    await expect(createOrder(unknownFetcher)).resolves.toMatchObject({ kind: 'unknown' });
    const enrollment = AnisEnrollmentClient.create({
      authority: 'https://partners.example',
      invitationId: id,
      enrollmentToken: 'token',
      fetch: enrollmentFetch.fetcher,
      logger,
    });
    await expect(enrollment.get()).resolves.toBeDefined();
    expect(loggerCalls).toBeGreaterThan(0);
    expect(keyFetchLogCalls).toBeGreaterThan(0);
  });
});
