import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PartnerWebhookVerifier } from '../../src/verification/partner-webhook-verifier.js';
import { PartnerWebhookSignatureBase } from '../../src/verification/partner-webhook-signature-base.js';
import type { PublishedSigningKey, SigningKeySet } from '../../src/verification/partner-jwk.js';
import type { VerifiableWebhook } from '../../src/verification/verifiable-webhook.js';
import { UnverifiableWebhookError } from '../../src/verification/unverifiable-webhook-error.js';
import {
  WEBHOOK_VERIFICATION_FAILURES,
  type WebhookVerificationFailure,
} from '../../src/verification/webhook-verification-failure.js';

// Public known-answer bytes are pinned independently of the in-test signer.
const knownAnswer = {
  x: 'axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY',
  y: 'T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU',
  created: 1792484040,
  expires: 1792484340,
  kid: 'partner-webhook-signing/0123456789abcdef0123456789abcdef',
  bodyUtf8:
    '{"id":"4bceba8e-55d1-59ec-b560-6c1e08f2ae3a","type":"meterCharge.succeeded","occurredAt":"2026-10-20T08:13:02Z","applicationId":"9b2d1241-413e-4ae8-ae32-b15c58dbe101","data":{"completedAt":"2026-10-20T08:13:02Z","createdAt":"2026-10-20T08:12:44Z","externalReference":"POS-77-INV-1093","meterNumber":"0268000710262","operationId":"3c1e9b7a-0d42-4f5e-8a61-2b9c7d0e5f13","package":{"gecolPackageName":"PKG_100","id":"5f3b8c21-5f3b-4c21-8f3b-5f3b8c215f3b","name":"باقة 100 دينار"},"personalPrice":{"amount":"100.000","currency":"LYD"},"receipt":{"creditedAmount":"88.640","receiptNumber":"260020103744","taxes":[{"amount":"5.000","description":"ضريبة الاستهلاك"},{"amount":"3.860","description":"رسوم الخدمة"}],"tokens":[{"code":"1234 5678 9012 3456 7890","description":"Key change token 1","label":"KCT1","sequence":1},{"code":"2345 6789 0123 4567 8901","description":"Key change token 2","label":"KCT2","sequence":2},{"code":"5821 0034 7719 2265 0418","description":"Credit token","label":"STS","sequence":3}]},"status":"succeeded","total":{"amount":"97.500","currency":"LYD"},"walletId":"71825266-7182-4182-8182-718252667182"}}',
  contentDigest: 'sha-256=:5eOPolCTWCigpjkrmQotTNZ5SIRvsvUX2Bm6HpP3DJQ=:',
  signatureInput:
    'sig1=("@method" "@target-uri" "content-digest" "webhook-id" "anis-webhook-attempt" "anis-application-id");created=1792484040;expires=1792484340;keyid="partner-webhook-signing/0123456789abcdef0123456789abcdef";alg="ecdsa-p256-sha256";tag="anis-partner-webhook-v1"',
  signatureBase:
    '"@method": POST\n"@target-uri": https://pos.example.ly/hooks/anis\n"content-digest": sha-256=:5eOPolCTWCigpjkrmQotTNZ5SIRvsvUX2Bm6HpP3DJQ=:\n"webhook-id": 4bceba8e-55d1-59ec-b560-6c1e08f2ae3a\n"anis-webhook-attempt": 1\n"anis-application-id": 9b2d1241-413e-4ae8-ae32-b15c58dbe101\n"@signature-params": ("@method" "@target-uri" "content-digest" "webhook-id" "anis-webhook-attempt" "anis-application-id");created=1792484040;expires=1792484340;keyid="partner-webhook-signing/0123456789abcdef0123456789abcdef";alg="ecdsa-p256-sha256";tag="anis-partner-webhook-v1"',
  signature: 'sig1=:Sm8JgMPGsDVeO74AWNz0+8qZNgIxptB5dpBU/kMIrMbtZsCsP856wLnhCOld+4qSgrlb9lMBIZsFHJMPrrbJUg==:',
};
const suspendedEnvelope = {
  id: '0ef5f62f-b3f0-5436-8e1f-5806629ad7c0',
  type: 'directRecharge.suspended',
  occurredAt: '2026-10-20T10:00:00Z',
  applicationId: '9b2d1241-413e-4ae8-ae32-b15c58dbe101',
  data: {
    commission: {
      amount: '5.000',
      currency: 'LYD',
    },
    exchangeRate: '0.155000',
    externalReference: 'POS-77-TR-551',
    note: 'Family support',
    number: 30412,
    operationId: '7d4e1a90-5b2c-4e7f-8a13-0c9d6e2b4f81',
    payout: {
      amount: '1500.000',
      currency: {
        name: 'جنيه مصري',
      },
    },
    price: {
      amount: '232.500',
      currency: 'LYD',
    },
    product: {
      id: 'e7c2a9d4-1b3f-4a85-9c60-8d2e4f7b1a93',
      title: 'فودافون كاش مصر',
    },
    recipient: [
      {
        key: 'recipient_number',
        name: {
          ar: 'رقم المحفظة',
          en: 'Wallet number',
        },
        value: '01098765432',
      },
      {
        key: 'recipient_name',
        name: {
          ar: 'اسم المستلم',
          en: 'Recipient name',
        },
        value: 'Ahmed Ali Hassan',
      },
    ],
    requestedAt: '2026-10-20T09:00:00Z',
    status: 'inProgress',
    total: {
      amount: '237.500',
      currency: 'LYD',
    },
    walletId: '71825266-7182-4182-8182-718252667182',
  },
};
const created = knownAnswer.created;
const receiver = {
  configuredUrl: 'https://pos.example.ly/hooks/anis',
  applicationId: '9b2d1241-413e-4ae8-ae32-b15c58dbe101',
};
const eventId = '4bceba8e-55d1-59ec-b560-6c1e08f2ae3a';
const otherId = '3c1e9b7a-0d42-4f5e-8a61-2b9c7d0e5f13';
const publicKey: PublishedSigningKey = {
  kty: 'EC',
  crv: 'P-256',
  x: knownAnswer.x,
  y: knownAnswer.y,
  kid: knownAnswer.kid,
  purpose: 'webhook',
  status: 'active',
  notBefore: new Date((created - 60) * 1000).toISOString(),
};
const privateKey = await crypto.subtle.importKey(
  'jwk',
  {
    kty: 'EC',
    crv: 'P-256',
    x: knownAnswer.x,
    y: knownAnswer.y,
    d: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE',
  },
  { name: 'ECDSA', namedCurve: 'P-256' },
  false,
  ['sign'],
);
const envelope = {
  id: eventId,
  type: 'future.event',
  occurredAt: '2026-10-20T08:13:02Z',
  applicationId: receiver.applicationId,
  data: { text: 'مرحباً' },
};
const components = [
  '@method',
  '@target-uri',
  'content-digest',
  'webhook-id',
  'anis-webhook-attempt',
  'anis-application-id',
];
interface SigningOptions {
  method?: string;
  targetUri?: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
  components?: string[];
  created?: number;
  expires?: number | null;
  algorithm?: string | null;
  tag?: string | null;
  kid?: string;
  label?: string;
}
async function signed(options: SigningOptions = {}): Promise<VerifiableWebhook> {
  const body = options.body ?? new TextEncoder().encode(JSON.stringify(envelope));
  const headers: Record<string, string> = {
    'content-digest': `sha-256=:${createHash('sha256').update(body).digest('base64')}:`,
    'webhook-id': eventId,
    'anis-webhook-attempt': '1',
    'anis-application-id': receiver.applicationId,
    ...options.headers,
  };
  const time = options.created ?? created;
  const coverage = options.components ?? components;
  const params =
    `(${coverage.map((part) => `"${part}"`).join(' ')});created=${String(time)}` +
    (options.expires === null ? '' : `;expires=${String(options.expires ?? time + 300)}`) +
    `;keyid="${options.kid ?? knownAnswer.kid}"` +
    (options.algorithm === null ? '' : `;alg="${options.algorithm ?? 'ecdsa-p256-sha256'}"`) +
    (options.tag === null ? '' : `;tag="${options.tag ?? 'anis-partner-webhook-v1'}"`);
  const request = {
    method: options.method ?? 'POST',
    targetUri: options.targetUri ?? receiver.configuredUrl,
    headers,
    body,
  };
  const values: Record<string, string> = { ...headers, '@method': request.method, '@target-uri': request.targetUri };
  const base = [...coverage.map((name) => `"${name}": ${values[name] ?? ''}`), `"@signature-params": ${params}`].join(
    '\n',
  );
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(base),
  );
  headers['signature-input'] = `${options.label ?? 'sig1'}=${params}`;
  headers.signature = `${options.label ?? 'sig1'}=:${Buffer.from(signature).toString('base64')}:`;
  return request;
}
function verifier(
  keys: SigningKeySet = { keys: [publicKey] },
  now = created + 5,
  config = receiver,
): PartnerWebhookVerifier {
  return new PartnerWebhookVerifier(
    { get: () => Promise.resolve(keys), refresh: () => Promise.resolve(keys) },
    config,
    { now: () => new Date(now * 1000) },
  );
}
function changedHeader(request: VerifiableWebhook, name: string, value?: string): VerifiableWebhook {
  const headers = Object.fromEntries(Object.entries(request.headers).filter(([key]) => key !== name));
  if (value !== undefined) headers[name] = value;
  return { ...request, headers };
}
function jsonBody(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}
interface RefusalCase {
  request: VerifiableWebhook;
  keys?: SigningKeySet;
  now?: number;
  parse?: boolean;
}
const refusals: Record<WebhookVerificationFailure, () => Promise<RefusalCase>> = {
  signature_missing: async () => ({ request: changedHeader(await signed(), 'signature') }),
  signature_malformed: async () => ({ request: changedHeader(await signed(), 'signature', 'sig1=:YQ==:') }),
  signature_invalid: async () => ({ request: changedHeader(await signed(), 'anis-webhook-attempt', '2') }),
  content_digest_mismatch: async () => ({ request: { ...(await signed()), body: jsonBody({ modified: true }) } }),
  covered_components_mismatch: async () => ({ request: await signed({ components: components.slice(1) }) }),
  unknown_key: async () => ({ request: await signed({ kid: 'unpublished/exact' }) }),
  key_rejected: async () => ({ request: await signed(), keys: { keys: [{ ...publicKey, x: 'invalid' }] } }),
  algorithm_not_supported: async () => ({ request: await signed({ algorithm: 'rsa-v1' }) }),
  label_unexpected: async () => ({ request: await signed({ label: 'sig2' }) }),
  created_out_of_window: async () => ({ request: await signed({ created: created + 306 }) }),
  profile_unexpected: async () => ({ request: await signed({ tag: 'anis-response-v2' }) }),
  key_compromised: async () => ({
    request: await signed(),
    keys: {
      keys: [publicKey],
      revoked: [{ kid: knownAnswer.kid, compromisedAt: new Date((created + 1) * 1000).toISOString() }],
    },
  }),
  key_retired: async () => ({
    request: await signed(),
    keys: { keys: [{ ...publicKey, status: 'retired', retiredAt: new Date((created + 1) * 1000).toISOString() }] },
  }),
  key_not_yet_valid: async () => ({
    request: await signed(),
    keys: { keys: [{ ...publicKey, notBefore: new Date((created + 1) * 1000).toISOString() }] },
  }),
  signature_expired: async () => ({ request: await signed(), now: created + 301 }),
  validity_window_invalid: async () => ({ request: await signed({ expires: created + 299 }) }),
  target_uri_mismatch: async () => ({ request: await signed({ targetUri: 'https://other.example/hooks' }) }),
  application_id_mismatch: async () => ({ request: await signed({ headers: { 'anis-application-id': otherId } }) }),
  key_purpose_mismatch: async () => ({
    request: await signed(),
    keys: { keys: [{ ...publicKey, purpose: 'answer' }] },
  }),
  method_unexpected: async () => ({ request: await signed({ method: 'GET' }) }),
  event_id_mismatch: async () => ({
    request: await signed({ body: jsonBody({ ...envelope, id: otherId }) }),
    parse: true,
  }),
  envelope_invalid: async () => ({
    request: await signed({ body: jsonBody({ ...envelope, data: null }) }),
    parse: true,
  }),
};

describe('partner webhook verifier', () => {
  it('keeps exactly the 22 declared failure reasons covered', () => {
    expect(WEBHOOK_VERIFICATION_FAILURES).toHaveLength(22);
    expect(Object.keys(refusals).sort()).toEqual([...WEBHOOK_VERIFICATION_FAILURES].sort());
  });
  it.each(WEBHOOK_VERIFICATION_FAILURES)('refuses %s with its exact reason', async (reason) => {
    const scenario = await refusals[reason]();
    const instance = verifier(scenario.keys, scenario.now);
    const operation = scenario.parse ? instance.verifyAndParse(scenario.request) : instance.verify(scenario.request);
    await expect(operation).rejects.toBeInstanceOf(UnverifiableWebhookError);
    await expect(operation).rejects.toMatchObject({ failure: reason });
  });
  it.each(['active', 'next'] as const)(
    'accepts an activated %s key and preserves unknown future data',
    async (status) => {
      const result = await verifier({ keys: [{ ...publicKey, status }] }).verifyAndParse(await signed());
      expect(result).toMatchObject({ id: eventId, rawType: 'future.event', data: envelope.data });
    },
  );
  it('accepts the independent known-answer signature and rebuilds its exact base', async () => {
    const request = {
      method: 'POST',
      targetUri: receiver.configuredUrl,
      body: new TextEncoder().encode(knownAnswer.bodyUtf8),
      headers: {
        'webhook-id': eventId,
        'anis-webhook-attempt': '1',
        'anis-application-id': receiver.applicationId,
        'content-digest': knownAnswer.contentDigest,
        'signature-input': knownAnswer.signatureInput,
        signature: knownAnswer.signature,
      },
    };
    expect(
      new TextDecoder().decode(
        PartnerWebhookSignatureBase.build(
          'POST',
          receiver.configuredUrl,
          knownAnswer.contentDigest,
          eventId,
          '1',
          receiver.applicationId,
          knownAnswer.signatureInput.slice(5),
        ),
      ),
    ).toBe(knownAnswer.signatureBase);
    await expect(verifier().verifyAndParse(request)).resolves.toMatchObject({ type: 'meterCharge.succeeded' });
  });
  it('accepts raw Arabic UTF-8 and whitespace without reserializing', async () => {
    const body = new TextEncoder().encode(` \n ${JSON.stringify(envelope, null, 2)} \n`);
    await expect(verifier().verifyAndParse(await signed({ body }))).resolves.toMatchObject({ data: envelope.data });
  });
  it('preserves a query-bearing configured URL and case-insensitive headers', async () => {
    const config = { ...receiver, configuredUrl: `${receiver.configuredUrl}?a=%2f&b=+&c=%D8%A7` };
    const request = await signed({ targetUri: config.configuredUrl });
    const headers = Object.fromEntries(
      Object.entries(request.headers).map(([name, value]) => [name.toUpperCase(), value]),
    );
    await expect(verifier(undefined, undefined, config).verify({ ...request, headers })).resolves.toBeUndefined();
    await expect(
      verifier(undefined, undefined, config).verify({
        ...request,
        targetUri: config.configuredUrl.replace('%2f', '%2F'),
      }),
    ).rejects.toMatchObject({ failure: 'target_uri_mismatch' });
  });
  it('SuspendedType_CurrentInProgressData_IsAccepted', async () => {
    const request = await signed({
      body: jsonBody(suspendedEnvelope),
      headers: { 'webhook-id': suspendedEnvelope.id },
    });
    await expect(verifier().verifyAndParse(request)).resolves.toMatchObject({
      type: 'directRecharge.suspended',
      data: { status: 'inProgress' },
    });
  });
  it.each([created, created + 300, created - 300])('accepts the inclusive time boundary %i', async (now) => {
    await expect(verifier(undefined, now).verify(await signed())).resolves.toBeUndefined();
  });
  it('does not grant expiry grace within the next clock second', async () => {
    const instance = new PartnerWebhookVerifier(
      { get: () => Promise.resolve({ keys: [publicKey] }), refresh: () => Promise.resolve({ keys: [publicKey] }) },
      receiver,
      { now: () => new Date((created + 300) * 1000 + 1) },
    );
    await expect(instance.verify(await signed())).rejects.toMatchObject({ failure: 'signature_expired' });
  });
  it('accepts creation exactly at notBefore and rejects a fractional activation later in the same second', async () => {
    const request = await signed();
    await expect(
      verifier({ keys: [{ ...publicKey, notBefore: new Date(created * 1000).toISOString() }] }).verify(request),
    ).resolves.toBeUndefined();
    await expect(
      verifier({ keys: [{ ...publicKey, notBefore: new Date(created * 1000 + 1).toISOString() }] }).verify(request),
    ).rejects.toMatchObject({ failure: 'key_not_yet_valid' });
  });
  it.each(['signature', 'signature-input'])('rejects a missing %s', async (name) => {
    await expect(verifier().verify(changedHeader(await signed(), name))).rejects.toMatchObject({
      failure: 'signature_missing',
    });
  });
  it('checks signature presence before syntax and receiver policy before fetching keys', async () => {
    const request = changedHeader(await signed(), 'signature');
    await expect(verifier().verify(changedHeader(request, 'Signature-Input', 'malformed'))).rejects.toMatchObject({
      failure: 'signature_missing',
    });
    const get = vi.fn(() => Promise.resolve({ keys: [publicKey] }));
    const refresh = vi.fn(() => Promise.resolve({ keys: [publicKey] }));
    const instance = new PartnerWebhookVerifier({ get, refresh }, receiver, { now: () => new Date(created * 1000) });
    await expect(instance.verify(await signed({ method: 'GET' }))).rejects.toMatchObject({
      failure: 'method_unexpected',
    });
    expect(get).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
  it.each(['webhook-id', 'anis-webhook-attempt', 'anis-application-id'])(
    'rejects a missing or duplicate %s binding',
    async (name) => {
      const request = await signed();
      await expect(verifier().verify(changedHeader(request, name))).rejects.toMatchObject({
        failure: 'covered_components_mismatch',
      });
      await expect(
        verifier().verify(changedHeader(request, name.toUpperCase(), request.headers[name])),
      ).rejects.toMatchObject({ failure: 'covered_components_mismatch' });
    },
  );
  it.each(['0', '-1', '1.0', '1, 2', ' 1', '1\n'])('rejects a malformed attempt %j', async (attempt) => {
    await expect(
      verifier().verify(await signed({ headers: { 'anis-webhook-attempt': attempt } })),
    ).rejects.toMatchObject({ failure: 'covered_components_mismatch' });
  });
  it.each([undefined, 'sha-256=:wrong:'])('rejects a missing or wrong digest %j', async (digest) => {
    await expect(verifier().verify(changedHeader(await signed(), 'content-digest', digest))).rejects.toMatchObject({
      failure: 'content_digest_mismatch',
    });
  });
  it.each(['signature', 'signature-input'])('rejects duplicate %s headers and dictionary labels', async (name) => {
    const request = await signed();
    await expect(
      verifier().verify(changedHeader(request, name.toUpperCase(), request.headers[name])),
    ).rejects.toMatchObject({ failure: 'signature_malformed' });
    await expect(
      verifier().verify(changedHeader(request, name, `${request.headers[name] ?? ''}, ${request.headers[name] ?? ''}`)),
    ).rejects.toMatchObject({ failure: 'signature_malformed' });
  });
  it.each(['created', 'expires', 'keyid', 'alg', 'tag'])('rejects duplicate %s parameters', async (name) => {
    const request = await signed();
    await expect(
      verifier().verify(
        changedHeader(request, 'signature-input', `${request.headers['signature-input'] ?? ''};${name}=1`),
      ),
    ).rejects.toMatchObject({ failure: 'signature_malformed' });
  });
  it.each([
    { algorithm: null, reason: 'algorithm_not_supported' },
    { tag: null, reason: 'profile_unexpected' },
    { expires: null, reason: 'validity_window_invalid' },
  ] as const)('rejects missing required parameters with $reason', async ({ reason, ...options }) => {
    await expect(verifier().verify(await signed(options))).rejects.toMatchObject({ failure: reason });
  });
  it('rejects a validly signed reordered coverage list', async () => {
    await expect(verifier().verify(await signed({ components: [...components].reverse() }))).rejects.toMatchObject({
      failure: 'covered_components_mismatch',
    });
  });
  it('checks lifetime before expiry, expiry before age, and digest before coverage', async () => {
    await expect(
      verifier(undefined, created + 301).verify(await signed({ expires: created + 1 })),
    ).rejects.toMatchObject({ failure: 'validity_window_invalid' });
    await expect(verifier(undefined, created + 301).verify(await signed())).rejects.toMatchObject({
      failure: 'signature_expired',
    });
    await expect(
      verifier().verify({ ...(await signed({ components: [] })), body: new Uint8Array() }),
    ).rejects.toMatchObject({ failure: 'content_digest_mismatch' });
  });
  it('refreshes an unknown exact opaque kid once and forwards key request options', async () => {
    const get = vi.fn(() => Promise.resolve({ keys: [] }));
    const refresh = vi.fn(() => Promise.resolve({ keys: [publicKey] }));
    const options = { signal: new AbortController().signal };
    const instance = new PartnerWebhookVerifier({ get, refresh }, receiver, { now: () => new Date(created * 1000) });
    await expect(instance.verify(await signed(), options)).resolves.toBeUndefined();
    expect(get).toHaveBeenCalledWith(options);
    expect(refresh).toHaveBeenCalledExactlyOnceWith(options);
    await expect(
      verifier().verify(await signed({ kid: `https://vault.example/${knownAnswer.kid}` })),
    ).rejects.toMatchObject({ failure: 'unknown_key' });
  });
  it('refuses a revoked key discovered on refresh', async () => {
    const instance = new PartnerWebhookVerifier(
      {
        get: () => Promise.resolve({ keys: [] }),
        refresh: () =>
          Promise.resolve({
            keys: [publicKey],
            revoked: [{ kid: knownAnswer.kid, compromisedAt: '2026-10-20T00:00:00Z' }],
          }),
      },
      receiver,
      { now: () => new Date(created * 1000) },
    );
    await expect(instance.verify(await signed())).rejects.toMatchObject({ failure: 'key_compromised' });
  });
  it('refuses missing purpose, private material, ambiguous kids and invalid points', async () => {
    const { purpose: _purpose, ...withoutPurpose } = publicKey;
    expect(_purpose).toBe('webhook');
    await expect(verifier({ keys: [withoutPurpose] }).verify(await signed())).rejects.toMatchObject({
      failure: 'key_purpose_mismatch',
    });
    for (const keys of [
      [{ ...publicKey, d: 'private' }],
      [publicKey, publicKey],
      [
        {
          ...publicKey,
          x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          y: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        },
      ],
    ]) {
      await expect(verifier({ keys }).verify(await signed())).rejects.toMatchObject({
        failure: 'key_rejected',
      });
    }
  });
  it('rejects a flipped P1363 signature and a DER-shaped signature', async () => {
    const request = await signed();
    const bytes = Buffer.from((request.headers.signature ?? '').slice(6, -1), 'base64');
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    await expect(
      verifier().verify(changedHeader(request, 'signature', `sig1=:${bytes.toString('base64')}:`)),
    ).rejects.toMatchObject({ failure: 'signature_invalid' });
    await expect(
      verifier().verify(changedHeader(request, 'signature', `sig1=:${Buffer.alloc(70, 0x30).toString('base64')}:`)),
    ).rejects.toMatchObject({ failure: 'signature_malformed' });
  });
  it('checks envelope application binding after successful verification', async () => {
    const request = await signed({ body: jsonBody({ ...envelope, applicationId: otherId }) });
    await expect(verifier().verify(request)).resolves.toBeUndefined();
    await expect(verifier().verifyAndParse(request)).rejects.toMatchObject({ failure: 'application_id_mismatch' });
  });
  it.each([
    'not json',
    '[]',
    '{}',
    JSON.stringify({ ...envelope, occurredAt: 'bad' }),
    JSON.stringify({ ...envelope, type: 'meterCharge.succeeded', data: {} }),
  ])('refuses malformed signed envelope %s', async (body) => {
    await expect(
      verifier().verifyAndParse(await signed({ body: new TextEncoder().encode(body) })),
    ).rejects.toMatchObject({ failure: 'envelope_invalid' });
  });
  it('never parses an invalid signature, even when the envelope is malformed', async () => {
    const request = changedHeader(
      await signed({ body: new TextEncoder().encode('not json') }),
      'anis-webhook-attempt',
      '2',
    );
    await expect(verifier().verifyAndParse(request)).rejects.toMatchObject({ failure: 'signature_invalid' });
  });
});
