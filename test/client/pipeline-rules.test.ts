import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AnisPartnersClient } from '../../src/client.js';
import { PemP256Signer } from '../../src/signing/pem-p256-signer.js';
import { KeyedSigner } from '../../src/signing/keyed-signer.js';
import { Money } from '../../src/models/money.js';
import type { PartnerLogger } from '../../src/observability/logger.js';
import type { RequestSigner } from '../../src/signing/p256-signer.js';
import { signedFetchDouble } from '../support/signed-fetch.js';
import { InMemoryTelemetry } from '../support/telemetry.js';

const uuid = '2f1c8a94-6d37-4e52-b8a1-0c9e5d3f7b26';
const signer = new KeyedSigner({ sign: () => Promise.resolve(new Uint8Array(64)) }, uuid);
const telemetry = new InMemoryTelemetry();
const clientModule = import('../../src/client.js');
const create = async (
  fetch: typeof globalThis.fetch,
  logger?: Partial<PartnerLogger>,
  requestSigner: RequestSigner = signer,
) =>
  (await clientModule).AnisPartnersClient.create({
    options: { authority: 'https://partners.example' },
    signer: requestSigner,
    fetch,
    ...(logger === undefined ? {} : { logger }),
  });

describe('signed request pipeline rules', () => {
  it('keeps safe reads free of mutation headers and a body digest', async () => {
    const fake = await signedFetchDouble(() => ({
      body: `{"id":"${uuid}","balance":{"amount":"1","currency":"LYD"}}`,
    }));

    await (await create(fake.fetcher)).wallets.get(uuid);

    const headers = new Headers(fake.requests[0]?.init.headers);
    expect(headers.has('Nonce')).toBe(false);
    expect(headers.has('Content-Digest')).toBe(false);
    expect(headers.has('Signature')).toBe(true);
  });

  it('sends invoice reveals with no body bytes', async () => {
    const fake = await signedFetchDouble(() => ({ body: '{"items":[]}' }));

    await (await create(fake.fetcher)).ownedCards.revealInvoice(uuid, uuid);

    expect(fake.requests[0]?.body.byteLength).toBe(0);
    const headers = new Headers(fake.requests[0]?.init.headers);
    expect(headers.has('Content-Type')).toBe(false);
    expect(headers.get('Content-Digest')).toMatch(/^sha-256=:/);
  });

  it('does not return a body whose digest changed after signing', async () => {
    const fake = await signedFetchDouble(() => ({
      body: `{"id":"${uuid}","balance":{"amount":"1","currency":"LYD"}}`,
    }));
    const tampered: typeof globalThis.fetch = async (resource, init) => {
      const response = await fake.fetcher(resource, init);
      const bytes = new Uint8Array(await response.arrayBuffer());
      bytes[0] = bytes[0] === 123 ? 91 : 123;
      return new Response(bytes, { status: response.status, headers: response.headers });
    };

    await expect((await create(tampered)).wallets.get(uuid)).rejects.toMatchObject({
      failure: 'content_digest_mismatch',
    });
  });

  it('discards a signed answer that still carries content encoding', async () => {
    const fake = await signedFetchDouble(() => ({
      body: `{"id":"${uuid}","name":"Main","currency":"LYD","balance":{"amount":"1.000","currency":"LYD"}}`,
      headers: { 'Content-Encoding': 'gzip' },
    }));

    await expect((await create(fake.fetcher)).wallets.get(uuid)).rejects.toMatchObject({
      failure: 'content_digest_mismatch',
    });
  });

  it('counts a discarded response under its verification failure rule', async () => {
    const before = telemetry.measurements.length;
    const fake = await signedFetchDouble(() => ({
      body: `{"id":"${uuid}","name":"Main","currency":"LYD","balance":{"amount":"1.000","currency":"LYD"}}`,
    }));
    const tampered: typeof globalThis.fetch = async (resource, init) => {
      const response = await fake.fetcher(resource, init);
      const bytes = new Uint8Array(await response.arrayBuffer());
      bytes[0] = bytes[0] === 123 ? 91 : 123;
      return new Response(bytes, { status: response.status, headers: response.headers });
    };

    await expect((await create(tampered)).wallets.get(uuid)).rejects.toMatchObject({
      failure: 'content_digest_mismatch',
    });

    expect(telemetry.measurements.slice(before)).toContainEqual(
      expect.objectContaining({
        instrument: 'anis.partners.response.verification.failures',
        value: 1,
        attributes: { 'anis.verification.failure': 'content_digest_mismatch' },
      }),
    );
  });

  it('counts a content-encoded response as a digest verification failure', async () => {
    const before = telemetry.measurements.length;
    const fake = await signedFetchDouble(() => ({ body: `{"id":"${uuid}"}` }));
    const encoded: typeof globalThis.fetch = async (resource, init) => {
      const response = await fake.fetcher(resource, init);
      const headers = new Headers(response.headers);
      headers.set('content-encoding', 'gzip');
      return new Response(await response.arrayBuffer(), { status: response.status, headers });
    };

    await expect((await create(encoded)).profile.get()).rejects.toMatchObject({
      failure: 'content_digest_mismatch',
    });

    expect(telemetry.measurements.slice(before)).toContainEqual(
      expect.objectContaining({
        instrument: 'anis.partners.response.verification.failures',
        attributes: { 'anis.verification.failure': 'content_digest_mismatch' },
      }),
    );
  });

  it('logs a verified refusal with its public code and request id', async () => {
    const logs: { message: string; fields: Record<string, unknown> }[] = [];
    const fake = await signedFetchDouble(() => ({
      status: 409,
      body: '{"status":409,"code":"insufficient_balance","requestId":"req-test-001"}',
    }));
    const logger = {
      debug: (message: string, fields: Record<string, unknown>) => {
        logs.push({ message, fields });
      },
      info: (message: string, fields: Record<string, unknown>) => {
        logs.push({ message, fields });
      },
      warn: (message: string, fields: Record<string, unknown>) => {
        logs.push({ message, fields });
      },
      error: (message: string, fields: Record<string, unknown>) => {
        logs.push({ message, fields });
      },
    };

    await expect((await create(fake.fetcher, logger)).wallets.get(uuid)).rejects.toMatchObject({
      code: 'insufficient_balance',
      requestId: 'req-test-001',
    });

    const refusal = logs.find((entry) => entry.fields.eventId === 1002);
    const completed = logs.find((entry) => entry.fields.eventId === 1001);
    expect(completed?.message).toContain('requestId=req-test-001');
    expect(completed?.message).toContain(`elapsedMs=${String(completed?.fields.elapsedMs)}`);
    expect(refusal?.fields.eventId).toBe(1002);
    expect(refusal?.fields.code).toBe('insufficient_balance');
    expect(refusal?.fields.requestId).toBe('req-test-001');
    expect(refusal?.message).toContain('requestId=req-test-001');
    expect(refusal?.message).toContain(`retryable=${String(refusal?.fields.retryable)}`);
    expect(refusal?.message).toContain(`replayed=${String(refusal?.fields.replayed)}`);
  });

  it('does not label a shared signing-key cache hit as event 1005', async () => {
    const fake = await signedFetchDouble(() => ({ body: `{"id":"${uuid}"}` }));
    const authority = 'https://partners.example';
    const cacheKey = `anis_partners_keys_${createHash('sha256').update(authority).digest('hex').slice(0, 32)}`;
    const envelope = JSON.stringify({
      fetchedAt: Math.floor(Date.now() / 1000),
      document: JSON.stringify(fake.keySet),
    });
    const keyCache = {
      get: (key: string) => Promise.resolve(key === cacheKey ? envelope : undefined),
      set: () => Promise.resolve(),
    };
    const logs: { message: string; fields: Record<string, unknown> }[] = [];
    const logger: PartnerLogger = {
      debug: (message, fields) => {
        logs.push({ message, fields });
      },
      info: (message, fields) => {
        logs.push({ message, fields });
      },
      warn: (message, fields) => {
        logs.push({ message, fields });
      },
      error: (message, fields) => {
        logs.push({ message, fields });
      },
    };
    const before = telemetry.measurements.length;
    const client = AnisPartnersClient.create({
      options: { authority },
      signer,
      fetch: fake.fetcher,
      keyCache,
      logger,
    });

    await client.profile.get();

    const cacheRead = logs.find((entry) => entry.message === 'signing keys read from the shared cache');
    expect(cacheRead).toBeDefined();
    expect(cacheRead?.fields.eventId).toBeUndefined();
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.url.pathname).toBe('/v1/profile');
    expect(
      telemetry.measurements
        .slice(before)
        .some((measurement) => measurement.instrument === 'anis.partners.signing_keys.fetches'),
    ).toBe(false);
  });

  it('tags client spans with the route template and request outcome', async () => {
    const before = telemetry.spans.length;
    const fake = await signedFetchDouble(() => ({
      body: `{"id":"${uuid}","name":"Main","currency":"LYD","balance":{"amount":"1.000","currency":"LYD"}}`,
    }));

    await (await create(fake.fetcher)).wallets.get(uuid);

    const span = telemetry.spans[before];
    expect(span?.name).toBe('anis.partners /v1/wallets/{walletId}');
    expect(span?.attributes).toMatchObject({
      'anis.route': '/v1/wallets/{walletId}',
      'http.request.method': 'GET',
      'http.response.status_code': 200,
      'anis.request_id': 'req-test-001',
    });
  });

  it('measures request duration separately from signing duration', async () => {
    const before = telemetry.measurements.length;
    const fake = await signedFetchDouble(() => ({
      body: `{"id":"${uuid}","name":"Main","currency":"LYD","balance":{"amount":"1.000","currency":"LYD"}}`,
    }));

    await (await create(fake.fetcher)).wallets.get(uuid);

    const measurements = telemetry.measurements.slice(before);
    expect(measurements.some((item) => item.instrument === 'anis.partners.request.duration')).toBe(true);
    expect(measurements).toContainEqual(
      expect.objectContaining({
        instrument: 'anis.partners.signature.duration',
        attributes: { 'anis.signature.profile': 'SafeRead' },
      }),
    );
  });

  it('counts unresolved orders with their operation id and failure type', async () => {
    const before = telemetry.measurements.length;
    const operationId = 'b26bf827-8484-44aa-987a-b033e4cfa401';
    const fake: typeof globalThis.fetch = () => Promise.reject(new TypeError('connection reset'));
    const client = await create(fake);

    const result = await client.orders.create(uuid, operationId, {
      cardId: uuid,
      quantity: 1,
      expectedUnitPrice: Money.of('1.000', 'LYD'),
      expectedTotal: Money.of('1.000', 'LYD'),
    });

    expect(result.kind).toBe('unknown');
    const outcome = telemetry.measurements
      .slice(before)
      .find((item) => item.instrument === 'anis.partners.order.outcomes');
    expect(outcome).toMatchObject({
      attributes: { 'anis.client': 'default', 'anis.order.outcome': 'unknown', 'error.type': 'connection' },
      value: 1,
    });
    const span = telemetry.spans.at(-1);
    expect(span?.attributes['anis.operation_id']).toBe(operationId);
  });

  it('marks timeout telemetry and the order outcome as unknown', async () => {
    const before = telemetry.measurements.length;
    const operationId = 'b26bf827-8484-44aa-987a-b033e4cfa401';
    const client = (await clientModule).AnisPartnersClient.create({
      options: { authority: 'https://partners.example', timeoutMs: 5 },
      signer,
      fetch: (_resource, init = {}) =>
        new Promise((_resolve, reject) => {
          const signal = init.signal;
          if (signal == null) {
            reject(new Error('timeout signal was not supplied'));
            return;
          }
          signal.addEventListener(
            'abort',
            () => {
              const reason: unknown = signal.reason;
              reject(reason instanceof Error ? reason : new Error('Request timed out.'));
            },
            { once: true },
          );
        }),
    });

    const result = await client.orders.create(uuid, operationId, {
      cardId: uuid,
      quantity: 1,
      expectedUnitPrice: Money.of('1.000', 'LYD'),
      expectedTotal: Money.of('1.000', 'LYD'),
    });

    expect(result.kind).toBe('unknown');
    const outcome = telemetry.measurements
      .slice(before)
      .find((measurement) => measurement.instrument === 'anis.partners.order.outcomes');
    expect(outcome?.attributes['anis.order.outcome']).toBe('unknown');
    expect(outcome?.attributes['error.type']).toBe('timeout');
    const duration = telemetry.measurements
      .slice(before)
      .find((measurement) => measurement.instrument === 'anis.partners.request.duration');
    expect(duration?.attributes['error.type']).toBe('timeout');
    expect(telemetry.spans.at(-1)?.status.code).toBe(2);
    expect(telemetry.spans.at(-1)?.attributes['error.type']).toBe('timeout');
  });

  it('counts an unverifiable successful order answer as unknown', async () => {
    const before = telemetry.measurements.length;
    const fake = await signedFetchDouble(() => ({
      status: 201,
      body: `{"operationId":"b26bf827-8484-44aa-987a-b033e4cfa401","status":"completed"}`,
    }));
    const tampered: typeof globalThis.fetch = async (resource, init) => {
      const response = await fake.fetcher(resource, init);
      const bytes = new Uint8Array(await response.arrayBuffer());
      bytes[0] = bytes[0] === 123 ? 91 : 123;
      return new Response(bytes, { status: response.status, headers: response.headers });
    };
    const client = await create(tampered);

    const result = await client.orders.create(uuid, 'b26bf827-8484-44aa-987a-b033e4cfa401', {
      cardId: uuid,
      quantity: 1,
      expectedUnitPrice: Money.of('1.000', 'LYD'),
      expectedTotal: Money.of('1.000', 'LYD'),
    });

    expect(result.kind).toBe('unknown');
    const outcome = telemetry.measurements
      .slice(before)
      .find((measurement) => measurement.instrument === 'anis.partners.order.outcomes');
    expect(outcome?.attributes['error.type']).toBe('unverifiable');
  });

  it('reports a signing-key fetch failure as a connection error, not a verification failure', async () => {
    const before = telemetry.measurements.length;
    const signed = await signedFetchDouble(() => ({ body: `{"id":"${uuid}"}` }));
    const fetcher: typeof globalThis.fetch = async (resource, init) => {
      const url = new URL(typeof resource === 'string' || resource instanceof URL ? resource : resource.url);
      if (url.pathname === '/.well-known/partner-signing-keys.json') throw new TypeError('key service unavailable');
      return signed.fetcher(resource, init);
    };

    await expect((await create(fetcher)).profile.get()).rejects.toMatchObject({
      name: 'SigningKeyDocumentUnavailableError',
    });

    const measurements = telemetry.measurements.slice(before);
    expect(
      measurements.some((measurement) => measurement.instrument === 'anis.partners.response.verification.failures'),
    ).toBe(false);
    expect(
      measurements.find((measurement) => measurement.instrument === 'anis.partners.request.duration')?.attributes[
        'error.type'
      ],
    ).toBe('connection');
  });

  it('counts an empty successful order answer as an unknown outcome', async () => {
    const before = telemetry.measurements.length;
    const fake = await signedFetchDouble(() => ({ status: 201, body: 'null' }));
    const client = await create(fake.fetcher);

    const result = await client.orders.create(uuid, 'b26bf827-8484-44aa-987a-b033e4cfa401', {
      cardId: uuid,
      quantity: 1,
      expectedUnitPrice: Money.of('1.000', 'LYD'),
      expectedTotal: Money.of('1.000', 'LYD'),
    });

    expect(result).toMatchObject({ kind: 'unknown', cause: { code: 'internal_error' } });
    const outcome = telemetry.measurements
      .slice(before)
      .find((measurement) => measurement.instrument === 'anis.partners.order.outcomes');
    expect(outcome?.attributes['error.type']).toBe('empty_body');
  });

  it('logs access refusals as unresolved orders with their public code', async () => {
    const before = telemetry.measurements.length;
    const logs: { level: string; fields: Record<string, unknown> }[] = [];
    const logger = {
      debug: (_message: string, fields: Record<string, unknown>) => {
        logs.push({ level: 'debug', fields });
      },
      info: (_message: string, fields: Record<string, unknown>) => {
        logs.push({ level: 'info', fields });
      },
      warn: (_message: string, fields: Record<string, unknown>) => {
        logs.push({ level: 'warn', fields });
      },
      error: (_message: string, fields: Record<string, unknown>) => {
        logs.push({ level: 'error', fields });
      },
    };
    const fake = await signedFetchDouble(() => ({ status: 401, body: '{"status":401,"code":"invalid_credentials"}' }));
    const client = await create(fake.fetcher, logger);

    const result = await client.orders.create(uuid, 'b26bf827-8484-44aa-987a-b033e4cfa401', {
      cardId: uuid,
      quantity: 1,
      expectedUnitPrice: Money.of('1.000', 'LYD'),
      expectedTotal: Money.of('1.000', 'LYD'),
    });

    expect(result).toMatchObject({ kind: 'unknown', suggestedDelayMs: 60000 });
    expect(logs.some((entry) => entry.level === 'warn' && entry.fields.eventId === 1008)).toBe(true);
    expect(logs.find((entry) => entry.fields.eventId === 1008)?.fields.operationId).toBe(
      'b26bf827-8484-44aa-987a-b033e4cfa401',
    );
    const outcome = telemetry.measurements
      .slice(before)
      .find((measurement) => measurement.instrument === 'anis.partners.order.outcomes');
    expect(outcome?.attributes['error.type']).toBe('invalid_credentials');
    expect(outcome?.attributes).not.toHaveProperty('anis.operation_id');
  });

  it('counts unresolved refusals while excluding final order refusals', async () => {
    const before = telemetry.measurements.length;
    let calls = 0;
    const fake = await signedFetchDouble(() => {
      calls += 1;
      return calls === 1
        ? { status: 503, body: '{"status":503,"code":"dependency_unavailable"}' }
        : { status: 409, body: '{"status":409,"code":"insufficient_balance"}' };
    });
    const client = await create(fake.fetcher);
    const request = {
      cardId: uuid,
      quantity: 1,
      expectedUnitPrice: Money.of('1.000', 'LYD'),
      expectedTotal: Money.of('1.000', 'LYD'),
    };

    await client.orders.create(uuid, 'b26bf827-8484-44aa-987a-b033e4cfa401', request);
    await client.orders.create(uuid, '9b2e4f17-3c6a-4d58-b0e1-7a5c8d2f6b34', request);

    const outcomes = telemetry.measurements
      .slice(before)
      .filter((measurement) => measurement.instrument === 'anis.partners.order.outcomes');
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.attributes).toMatchObject({
      'anis.order.outcome': 'unknown',
      'error.type': 'dependency_unavailable',
    });
  });

  it('does not count a replayed refusal as an unresolved order', async () => {
    const before = telemetry.measurements.length;
    const fake = await signedFetchDouble(() => ({
      status: 500,
      headers: { 'Idempotency-Replayed': 'true' },
      body: '{"status":500,"code":"internal_error"}',
    }));
    const client = await create(fake.fetcher);

    const result = await client.orders.create(uuid, 'b26bf827-8484-44aa-987a-b033e4cfa401', {
      cardId: uuid,
      quantity: 1,
      expectedUnitPrice: Money.of('1.000', 'LYD'),
      expectedTotal: Money.of('1.000', 'LYD'),
    });

    expect(result.kind).toBe('notPlaced');
    expect(
      telemetry.measurements
        .slice(before)
        .some((measurement) => measurement.instrument === 'anis.partners.order.outcomes'),
    ).toBe(false);
  });

  it('does not count a signing failure as an unresolved order', async () => {
    const before = telemetry.measurements.length;
    const operationId = 'b26bf827-8484-44aa-987a-b033e4cfa401';
    const client = (await clientModule).AnisPartnersClient.create({
      options: { authority: 'https://partners.example' },
      signer: new KeyedSigner({ sign: () => Promise.reject(new Error('vault unavailable')) }, uuid),
      fetch: () => Promise.reject(new Error('request must not be sent')),
    });

    await expect(
      client.orders.create(uuid, operationId, {
        cardId: uuid,
        quantity: 1,
        expectedUnitPrice: Money.of('1.000', 'LYD'),
        expectedTotal: Money.of('1.000', 'LYD'),
      }),
    ).rejects.toThrow('could not be signed');

    const measurements = telemetry.measurements.slice(before);
    expect(measurements.some((measurement) => measurement.instrument === 'anis.partners.order.outcomes')).toBe(false);
    expect(
      measurements.find((measurement) => measurement.instrument === 'anis.partners.request.duration')?.attributes[
        'error.type'
      ],
    ).toBe('signing');
  });

  it('keeps credentials and signing material out of telemetry signals', async () => {
    const privateKeyBody =
      'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgyIpGK3RErH7j8NIijtNQ18k1tgiJBfxXcJ/qX+dZdzahRANCAASZ08XDV443a7dWnaQlMgX8dHIShU8Ta3IMgBcb2/O4nNvjoDQD0pcOP5uDAIq72HMqwK/+X0kbY4X8J7QRc7xK';
    const privatePem = `-----BEGIN PRIVATE KEY-----\n${privateKeyBody}\n-----END PRIVATE KEY-----\n`;
    const pemSigner = (await PemP256Signer.fromPem(privatePem)).forKey(uuid);
    const spanStart = telemetry.spans.length;
    const measurementStart = telemetry.measurements.length;
    const logs: string[] = [];
    const logger = {
      debug: (message: string, fields: Record<string, unknown>) => {
        logs.push(JSON.stringify({ level: 'debug', message, fields }));
      },
      info: (message: string, fields: Record<string, unknown>) => {
        logs.push(JSON.stringify({ level: 'info', message, fields }));
      },
      warn: (message: string, fields: Record<string, unknown>) => {
        logs.push(JSON.stringify({ level: 'warn', message, fields }));
      },
      error: (message: string, fields: Record<string, unknown>) => {
        logs.push(JSON.stringify({ level: 'error', message, fields }));
      },
    };
    const fake = await signedFetchDouble(() => ({
      body: `{"soldCardId":"${uuid}","voucher":"voucher-secret","serialNumber":"serial-secret"}`,
    }));

    await (await create(fake.fetcher, logger, pemSigner)).ownedCards.reveal(uuid, uuid);

    const orderFake = await signedFetchDouble(() => ({
      status: 201,
      body: `{"operationId":"b26bf827-8484-44aa-987a-b033e4cfa401","status":"completed","soldCards":[{"soldCardId":"${uuid}","voucher":"voucher-secret","serialNumber":"serial-secret"}]}`,
    }));
    await (
      await create(orderFake.fetcher, logger, pemSigner)
    ).orders.create(uuid, 'b26bf827-8484-44aa-987a-b033e4cfa401', {
      cardId: uuid,
      quantity: 1,
      expectedUnitPrice: Money.of('1.000', 'LYD'),
      expectedTotal: Money.of('1.000', 'LYD'),
    });

    const enrollmentFake = await signedFetchDouble(() => ({ body: '{"state":"pendingProof"}' }));
    const enrollment = (await import('../../src/enrollment/enrollment-client.js')).AnisEnrollmentClient.create({
      authority: 'https://partners.example',
      invitationId: uuid,
      enrollmentToken: 'enrollment-secret',
      fetch: enrollmentFake.fetcher,
      logger,
    });
    const fetchCount = telemetry.measurements.length;
    const spanCount = telemetry.spans.length;
    await enrollment.get();

    const emitted = logs.join('\n');
    const headers = new Headers(fake.requests[0]?.init.headers);
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of [
      'voucher-secret',
      'serial-secret',
      headers.get('Signature') ?? '',
      headers.get('Signature-Input') ?? '',
      headers.get('Nonce') ?? '',
    ])
      expect(emitted).not.toContain(secret);

    const allSignals = JSON.stringify({
      spans: telemetry.spans.slice(spanStart),
      measurements: telemetry.measurements.slice(measurementStart),
      logs,
    });
    expect(telemetry.spans.length).toBeGreaterThan(0);
    expect(telemetry.measurements.length).toBeGreaterThan(0);
    for (const secret of [
      'voucher-secret',
      'serial-secret',
      headers.get('Signature') ?? '',
      headers.get('Signature-Input') ?? '',
      headers.get('Nonce') ?? '',
      '@signature-params',
      'enrollment-secret',
      privateKeyBody,
    ])
      expect(allSignals).not.toContain(secret);
    const fetchMetric = telemetry.measurements
      .slice(fetchCount)
      .find((measurement) => measurement.instrument === 'anis.partners.signing_keys.fetches');
    expect(fetchMetric?.attributes['anis.fetch.reason']).toBe('first-use');
    expect(telemetry.spans.length).toBeGreaterThan(spanCount);
    expect(
      telemetry.measurements
        .slice(fetchCount)
        .some((measurement) => measurement.instrument === 'anis.partners.request.duration'),
    ).toBe(true);
  });
});
