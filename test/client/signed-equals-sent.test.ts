import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AnisPartnersClient } from '../../src/client.js';
import { Money } from '../../src/models/money.js';
import { arrayBufferOf } from '../../src/internal/bytes.js';
import { endpoint, meterIntent, rechargeIntent, accepted, eventAccepted } from '../operations/product-test-support.js';
import { signedFetchDouble } from '../support/signed-fetch.js';

const keyId = 'a9cb2df1-5a48-449b-8c8a-1b20a5b7f433';
const walletId = '2f1c8a94-6d37-4e52-b8a1-0c9e5d3f7b26';
const operationId = 'b26bf827-8484-44aa-987a-b033e4cfa401';

describe('signed request wire bytes', () => {
  it.each([
    'meter create',
    'meter resume',
    'direct recharge create',
    'direct recharge resume',
    'recipient update',
    'endpoint set',
    'endpoint test',
    'event redeliver',
  ] as const)('signs exactly the bytes sent for %s', async (method) => {
    const { client, requests, verifyRequest } = await setup();
    switch (method) {
      case 'meter create':
        await client.meterCharges.create(walletId, operationId, meterIntent);
        break;
      case 'meter resume':
        await client.meterCharges.resume(walletId, operationId, meterIntent);
        break;
      case 'direct recharge create':
        await client.directRecharges.create(walletId, operationId, rechargeIntent);
        break;
      case 'direct recharge resume':
        await client.directRecharges.resume(walletId, operationId, rechargeIntent);
        break;
      case 'recipient update':
        await client.directRecharges.updateRecipient(operationId, { recipient: rechargeIntent.recipient });
        break;
      case 'endpoint set':
        await client.webhookEndpoint.set({ url: endpoint.url });
        break;
      case 'endpoint test':
        await client.webhookEndpoint.test();
        break;
      case 'event redeliver':
        await client.webhookEvents.redeliver(operationId);
        break;
    }
    const purchase = method.includes('create') || method.includes('resume');
    await verifyRequest(requests[0], purchase ? 'order' : 'mutation');
    if (!purchase) expect(new Headers(requests[0]?.init.headers).has('Idempotency-Key')).toBe(false);
    if (method === 'endpoint test' || method === 'event redeliver')
      expect(new TextDecoder().decode(requests[0]?.body)).toBe('{}');
  });

  it('signs the new filtered collection query exactly as it is sent', async () => {
    const { client, requests, verifyRequest } = await setup();
    await client.meterCharges.getMeterChargesPage(walletId, {
      meterNumber: '000123',
      cursor: '+/=& عربي',
      from: new Date('2026-10-01T00:00:00Z'),
      pageSize: 50,
    });
    await verifyRequest(requests[0], 'read');
    expect(requests[0]?.url.searchParams.get('cursor')).toBe('+/=& عربي');
  });
  it('keeps a non-default authority port in the request signature base', async () => {
    const { client, requests, verifyRequest } = await setup('https://PARTNERS.EXAMPLE:8443');
    await client.profile.get();
    await verifyRequest(requests[0], 'read');
    expect(requests[0]?.url.host).toBe('partners.example:8443');
  });

  it('signs a cursor page query exactly as it is sent', async () => {
    const { client, requests, verifyRequest } = await setup();
    await client.wallets.listPage({ cursor: 'next / page' });
    await verifyRequest(requests[0], 'read');
    expect(requests[0]?.url.search).toBe('?cursor=next%20%2F%20page');
  });

  it('signs a zero-byte reveal exactly as it is sent', async () => {
    const { client, requests, verifyRequest } = await setup();
    await client.ownedCards.reveal(walletId, operationId);
    await verifyRequest(requests[0], 'mutation');
    expect(requests[0]?.body.byteLength).toBe(0);
  });

  it('signs the self-check empty JSON object exactly as it is sent', async () => {
    const { client, requests, verifyRequest } = await setup();
    await client.diagnostics.checkSignature();
    await verifyRequest(requests[0], 'mutation');
    expect(new TextDecoder().decode(requests[0]?.body)).toBe('{}');
  });

  it('signs the canonical operation id and exact order body', async () => {
    const { client, requests, verifyRequest } = await setup();
    await client.orders.create(walletId, operationId.toUpperCase(), {
      cardId: operationId,
      quantity: 1,
      expectedUnitPrice: Money.of('1.000', 'LYD'),
      expectedTotal: Money.of('1.000', 'LYD'),
    });
    await verifyRequest(requests[0], 'order');
    expect(new Headers(requests[0]?.init.headers).get('idempotency-key')).toBe(operationId);
  });
});

async function setup(authority = 'https://PARTNERS.EXAMPLE:443') {
  const pair = await globalThis.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const signer = {
    keyId,
    async sign(data: Uint8Array) {
      return new Uint8Array(
        await globalThis.crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, arrayBufferOf(data)),
      );
    },
  };
  const fake = await signedFetchDouble((url, init) => {
    if (url.pathname.endsWith('/meter-charges'))
      return init.method === 'POST'
        ? { status: 202, body: JSON.stringify(accepted('meterCharge', operationId)) }
        : { body: '{"items":[],"nextCursor":null}' };
    if (url.pathname.endsWith('/direct-recharges'))
      return { status: 202, body: JSON.stringify(accepted('directRecharge', operationId)) };
    if (url.pathname.endsWith('/recipient'))
      return {
        status: 202,
        body: JSON.stringify(accepted('directRecharge', operationId)),
        headers: { Location: `/v1/direct-recharges/${operationId}` },
      };
    if (url.pathname.endsWith('/webhook-endpoint')) return { body: JSON.stringify(endpoint) };
    if (url.pathname.endsWith('/test') || url.pathname.endsWith('/redeliver'))
      return { status: 202, body: JSON.stringify({ ...eventAccepted, id: operationId }) };
    if (url.pathname.endsWith('/wallets')) return { body: '{"items":[]}' };
    if (url.pathname.endsWith('/reveal')) return { body: `{"soldCardId":"${operationId}"}` };
    if (url.pathname.endsWith('/diagnostics/signature'))
      return { body: '{"coveredComponents":[],"effectiveScopes":[]}' };
    return { status: 201, body: `{"operationId":"${operationId}","status":"completed"}` };
  });
  const client = AnisPartnersClient.create({
    options: { authority, signatureLifetimeSeconds: 45 },
    signer,
    fetch: fake.fetcher,
  });
  const verifyRequest = async (
    request: (typeof fake.requests)[number] | undefined,
    profile: 'read' | 'mutation' | 'order',
  ) => {
    const expectedAuthority = new URL(authority).host;
    expect(request).toBeDefined();
    if (request === undefined) throw new Error('Expected the API request.');
    const headers = new Headers(request.init.headers);
    expect(request.url.host).toBe(expectedAuthority);
    expect(headers.get('x-anis-date')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const signatureInput = headers.get('signature-input');
    const signature = headers.get('signature');
    expect(signatureInput).not.toBeNull();
    expect(signature).not.toBeNull();
    const input = signatureInput ?? '';
    const parameters = input.slice('sig1='.length);
    const created = Number(/;created=(\d+)/.exec(parameters)?.[1]);
    const expires = Number(/;expires=(\d+)/.exec(parameters)?.[1]);
    expect(Date.parse(headers.get('x-anis-date') ?? '') / 1000).toBe(created);
    expect(expires - created).toBe(45);
    const query = request.url.search || '?';
    const digest = `sha-256=:${createHash('sha256').update(request.body).digest('base64')}:`;
    const nonce = headers.get('nonce');
    if (profile !== 'read') {
      expect(headers.get('content-digest')).toBe(digest);
      expect(nonce).toBe(/;nonce="([^"]+)"/.exec(parameters)?.[1]);
    }
    if (profile === 'order') expect(headers.get('idempotency-key')).toBe(operationId);
    const lines = [
      `"@method": ${String(request.init.method)}\n`,
      `"@authority": ${request.url.host.toLowerCase()}\n`,
      `"@path": ${request.url.pathname}\n`,
      `"@query": ${query}\n`,
    ];
    if (profile !== 'read') {
      lines.push(`"content-digest": ${digest}\n`, `"nonce": ${nonce ?? ''}\n`);
    }
    if (profile === 'order') lines.push(`"idempotency-key": ${operationId}\n`);
    lines.push(`"x-anis-date": ${headers.get('x-anis-date') ?? ''}\n`, `"@signature-params": ${parameters}`);
    const publicJwk = await globalThis.crypto.subtle.exportKey('jwk', pair.publicKey);
    const x = publicJwk.x;
    const y = publicJwk.y;
    if (x === undefined || y === undefined) throw new Error('Expected public coordinates.');
    const publicKey = await globalThis.crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', x, y },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const encodedSignature = /^sig1=:([A-Za-z0-9+/]+={0,2}):$/.exec(signature ?? '')?.[1];
    expect(encodedSignature).toBeDefined();
    const bytes = new Uint8Array(Buffer.from(encodedSignature ?? '', 'base64'));
    await expect(
      globalThis.crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        publicKey,
        bytes,
        arrayBufferOf(new TextEncoder().encode(lines.join(''))),
      ),
    ).resolves.toBe(true);
  };
  return { client, requests: fake.requests, verifyRequest };
}
