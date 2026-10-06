import { createHash } from 'node:crypto';
import type { PartnerJwk, SigningKeySet } from '../../src/verification/partner-jwk.js';
import { arrayBufferOf } from '../../src/internal/bytes.js';

const keyId = '7a0d6c46-6a7e-4c7d-84f7-2d5c7c92f4b0';

/** Creates an API fetch double that records requests and signs each response with its trusted test key. */
export async function signedFetchDouble(
  answer: (url: URL, init: RequestInit) => { status?: number; body?: string; headers?: HeadersInit },
) {
  const pair = await globalThis.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const publicJwk = await globalThis.crypto.subtle.exportKey('jwk', pair.publicKey);
  if (publicJwk.x === undefined || publicJwk.y === undefined)
    throw new TypeError('Generated key omitted its coordinates.');
  const jwk: PartnerJwk = { kty: 'EC', crv: 'P-256', x: publicJwk.x, y: publicJwk.y, kid: keyId };
  const requests: { url: URL; init: RequestInit; body: Uint8Array }[] = [];
  const keySet: SigningKeySet = { keys: [jwk] };
  const fetcher: typeof globalThis.fetch = async (resource, init = {}) => {
    const url = new URL(typeof resource === 'string' || resource instanceof URL ? resource : resource.url);
    if (url.pathname === '/.well-known/partner-signing-keys.json')
      return new Response(JSON.stringify(keySet), { status: 200 });
    const body = await bytesOfBody(init.body);
    requests.push({ url, init, body });
    const configured = answer(url, init);
    const status = configured.status ?? 200;
    const responseBody = new TextEncoder().encode(configured.body ?? '{}');
    const headers = new Headers(configured.headers);
    headers.set('Content-Digest', `sha-256=:${createHash('sha256').update(responseBody).digest('base64')}:`);
    headers.set('X-Request-Id', 'req-test-001');
    if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'no-store');
    const requestSignatureInput = new Headers(init.headers).get('Signature-Input') ?? undefined;
    const components = testResponseComponents(headers, status, requestSignatureInput);
    const created = Math.floor(Date.now() / 1000);
    const params = `(${components.map((part) => `"${part.name}"${part.requestBound ? ';req' : ''}`).join(' ')});created=${String(created)};keyid="${keyId}";alg="ecdsa-p256-sha256"`;
    const signature = new Uint8Array(
      await globalThis.crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        pair.privateKey,
        arrayBufferOf(testResponseBase(components, params)),
      ),
    );
    headers.set('Signature-Input', `sig1=${params}`);
    headers.set('Signature', `sig1=:${Buffer.from(signature).toString('base64')}:`);
    return new Response(responseBody, { status, headers });
  };
  return { fetcher, requests, keySet };
}

async function bytesOfBody(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (body === null || body === undefined) return new Uint8Array();
  return new Uint8Array(await new Response(body).arrayBuffer());
}

function testResponseComponents(headers: Headers, status: number, requestSignatureInput?: string) {
  const components = [
    { name: '@status', value: String(status), requestBound: false },
    { name: 'content-digest', value: headers.get('Content-Digest') ?? '', requestBound: false },
    { name: 'x-request-id', value: headers.get('X-Request-Id') ?? '', requestBound: false },
  ];
  if (requestSignatureInput !== undefined)
    components.push({ name: 'signature-input', value: requestSignatureInput, requestBound: true });
  for (const name of ['Location', 'Retry-After', 'Idempotency-Replayed', 'Cache-Control']) {
    const value = headers.get(name);
    if (value !== null) components.push({ name: name.toLowerCase(), value, requestBound: false });
  }
  return components;
}

function testResponseBase(components: ReturnType<typeof testResponseComponents>, params: string): Uint8Array {
  const lines = components.map((part) => `"${part.name}"${part.requestBound ? ';req' : ''}: ${part.value}\n`);
  lines.push(`"@signature-params": ${params}`);
  return new TextEncoder().encode(lines.join(''));
}
