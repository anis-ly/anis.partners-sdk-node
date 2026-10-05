import { createHash } from 'node:crypto';
import { PartnerResponseSignatureBase } from '../../src/verification/partner-response-signature-base.js';
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
    const body = init.body instanceof Uint8Array ? new Uint8Array(init.body) : new Uint8Array();
    requests.push({ url, init, body });
    const configured = answer(url, init);
    const status = configured.status ?? 200;
    const responseBody = new TextEncoder().encode(configured.body ?? '{}');
    const headers = new Headers(configured.headers);
    headers.set('Content-Digest', `sha-256=:${createHash('sha256').update(responseBody).digest('base64')}:`);
    headers.set('X-Request-Id', 'req-test-001');
    const requestSignatureInput = new Headers(init.headers).get('Signature-Input') ?? undefined;
    const components = PartnerResponseSignatureBase.components(
      status,
      headers.get('Content-Digest') ?? '',
      headers.get('X-Request-Id') ?? '',
      requestSignatureInput,
      headers.get('Location') ?? undefined,
      headers.get('Retry-After') ?? undefined,
      headers.get('Idempotency-Replayed') ?? undefined,
      headers.get('Cache-Control') ?? undefined,
    );
    const created = Math.floor(Date.now() / 1000);
    const params = `(${components.map((part) => `"${part.name}"${part.requestBound ? ';req' : ''}`).join(' ')});created=${String(created)};keyid="${keyId}";alg="ecdsa-p256-sha256"`;
    const signature = new Uint8Array(
      await globalThis.crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        pair.privateKey,
        arrayBufferOf(PartnerResponseSignatureBase.build(components, created, keyId)),
      ),
    );
    headers.set('Signature-Input', `sig1=${params}`);
    headers.set('Signature', `sig1=:${Buffer.from(signature).toString('base64')}:`);
    return new Response(responseBody, { status, headers });
  };
  return { fetcher, requests };
}
