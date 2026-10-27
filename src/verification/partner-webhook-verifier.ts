import { createHash } from 'node:crypto';
import { decodeBase64Url } from '../internal/base64url.js';
import { arrayBufferOf, fixedTimeEqual } from '../internal/bytes.js';
import { systemClock, type Clock } from '../internal/clock.js';
import {
  asObject,
  optionalTimestamp,
  requiredString,
  requiredUuid,
  requiredTimestamp,
} from '../models/model-parsing.js';
import { parseWebhookEnvelope, type WebhookEnvelope } from '../models/webhooks.js';
import type { PublishedSigningKey, SigningKeySet } from './partner-jwk.js';
import { PartnerWebhookSignatureBase } from './partner-webhook-signature-base.js';
import type { SigningKeyRequestOptions, SigningKeySource } from './signing-key-source.js';
import { UnverifiableWebhookError } from './unverifiable-webhook-error.js';
import type { VerifiableWebhook, WebhookReceiverOptions } from './verifiable-webhook.js';
import { parseWebhookSignatureInput } from './webhook-signature-input-parser.js';
import type { WebhookVerificationFailure } from './webhook-verification-failure.js';

/** Verifies raw notifications against trusted receiver bindings before exposing parsed contents. */
export class PartnerWebhookVerifier {
  private readonly receiver: WebhookReceiverOptions;

  /** Supplies key rotation, trusted endpoint identity and a replaceable clock independently of the request. */
  constructor(
    private readonly keys: SigningKeySource,
    receiver: WebhookReceiverOptions,
    private readonly clock: Clock = systemClock,
  ) {
    const url = new URL(receiver.configuredUrl);
    if (url.protocol !== 'https:' || url.hash || url.username || url.password)
      throw new TypeError('The configured webhook URL must be an absolute HTTPS URL without credentials or fragment.');
    this.receiver = { ...receiver };
  }

  /** Resolves only when every signature and receiver policy check passes, in contract first-failure order. */
  async verify(request: VerifiableWebhook, options?: SigningKeyRequestOptions): Promise<void> {
    const present = Object.keys(request.headers).filter((name) => request.headers[name]);
    if (!['signature-input', 'signature'].every((name) => present.some((key) => key.toLowerCase() === name)))
      fail('signature_missing', 'Both signature headers are required.');
    const input = header(request, 'signature-input', 'signature_malformed');
    const signature = header(request, 'signature', 'signature_malformed');
    if (!input || !signature) fail('signature_missing', 'Both signature headers are required.');
    const parsed = parseWebhookSignatureInput(input);
    const encoded = /^([a-z*][a-z0-9_.*-]*)=:([A-Za-z0-9+/]*={0,2}):$/.exec(signature);
    if (!parsed || !encoded) fail('signature_malformed', 'The signature headers must contain one unambiguous label.');
    const signatureBytes = Buffer.from(encoded[2] ?? '', 'base64');
    if (signatureBytes.toString('base64') !== encoded[2])
      fail('signature_malformed', 'The signature is not canonical base64.');
    if (parsed.label !== 'sig1' || encoded[1] !== 'sig1') fail('label_unexpected', 'Both labels must be sig1.');
    if (parsed.algorithm !== 'ecdsa-p256-sha256') fail('algorithm_not_supported', 'The webhook algorithm is required.');
    if (parsed.tag !== 'anis-partner-webhook-v1') fail('profile_unexpected', 'The webhook profile tag is required.');
    const digest = header(request, 'content-digest', 'content_digest_mismatch');
    if (
      !digest ||
      !fixedTimeEqual(
        new TextEncoder().encode(digest),
        new TextEncoder().encode(`sha-256=:${createHash('sha256').update(request.body).digest('base64')}:`),
      )
    )
      fail('content_digest_mismatch', 'The digest must describe the exact received bytes.');
    const expected = PartnerWebhookSignatureBase.identifiers;
    if (
      parsed.identifiers.length !== expected.length ||
      expected.some((name, index) => name !== parsed.identifiers[index])
    )
      fail('covered_components_mismatch', 'The covered components must match the ordered webhook profile.');
    const eventId = header(request, 'webhook-id', 'covered_components_mismatch');
    const attempt = header(request, 'anis-webhook-attempt', 'covered_components_mismatch');
    const applicationId = header(request, 'anis-application-id', 'covered_components_mismatch');
    if (
      !eventId ||
      !attempt ||
      !applicationId ||
      !/^[1-9][0-9]*$/.test(attempt) ||
      [eventId, applicationId].some((value) => /[\r\n,]/.test(value))
    )
      fail('covered_components_mismatch', 'All binding headers and a positive integer attempt are required.');
    // Refuse duplicate spellings even on fields outside the profile instead of silently selecting a value.
    const names = Object.keys(request.headers).map((name) => name.toLowerCase());
    if (new Set(names).size !== names.length) fail('signature_malformed', 'Duplicate HTTP fields are ambiguous.');
    if (
      parsed.expires === undefined ||
      parsed.expires - parsed.created !== PartnerWebhookSignatureBase.LIFETIME_SECONDS
    )
      fail('validity_window_invalid', 'The signing lifetime must be exactly 300 seconds.');
    const now = this.clock.now().getTime() / 1000;
    if (now > parsed.expires) fail('signature_expired', 'The signature has expired.');
    if (!Number.isFinite(now) || Math.abs(now - parsed.created) > PartnerWebhookSignatureBase.LIFETIME_SECONDS)
      fail('created_out_of_window', 'The signing instant is outside the allowed skew.');
    if (request.method !== 'POST') fail('method_unexpected', 'A webhook delivery must use POST.');
    if (request.targetUri !== this.receiver.configuredUrl)
      fail('target_uri_mismatch', 'The actual target must equal the configured full URL.');
    if (applicationId !== this.receiver.applicationId)
      fail('application_id_mismatch', 'The header application must equal the configured application.');

    let document = await this.keys.get(options);
    refuseCompromised(document, parsed.keyId);
    let key = resolve(document, parsed.keyId);
    if (!key) {
      document = await this.keys.refresh(options);
      refuseCompromised(document, parsed.keyId);
      key = resolve(document, parsed.keyId);
    }
    if (document.keys.some((candidate) => candidate.d !== undefined && candidate.d !== ''))
      fail('key_rejected', 'The published document must not carry private key material.');
    if (!key) fail('unknown_key', 'The exact signing key id is not published.');
    if (document.keys.filter((candidate) => candidate.kid === parsed.keyId).length !== 1)
      fail('key_rejected', 'The signing key id is ambiguous.');
    if (key.purpose !== 'webhook') fail('key_purpose_mismatch', 'The selected key must explicitly serve webhooks.');
    let notBefore: number;
    try {
      notBefore = requiredTimestamp({ notBefore: key.notBefore }, 'notBefore', 'SigningKey').getTime();
      if (key.status === 'retired') requiredTimestamp({ retiredAt: key.retiredAt }, 'retiredAt', 'SigningKey');
    } catch {
      fail('key_rejected', 'The key lifecycle timestamps must be valid RFC3339 instants.');
    }
    if (key.status === 'retired') fail('key_retired', 'Retired keys cannot verify webhook deliveries.');
    if (key.status !== 'active' && key.status !== 'next')
      fail('key_rejected', 'The key lifecycle status is unsupported.');
    const fraction = /:\d{2}\.(\d+)/.exec(key.notBefore ?? '')?.[1];
    const activationSecond =
      fraction !== undefined && /[1-9]/.test(fraction) ? Math.floor(notBefore / 1000) + 1 : Math.ceil(notBefore / 1000);
    if (parsed.created < activationSecond) fail('key_not_yet_valid', 'The signature predates key activation.');
    if (
      key.kty !== 'EC' ||
      key.crv !== 'P-256' ||
      (key.alg !== undefined && key.alg !== 'ES256') ||
      (key.use !== undefined && key.use !== 'sig')
    )
      fail('key_rejected', 'The published key metadata must describe an EC P-256 signing key.');
    const x = decodeBase64Url(key.x);
    const y = decodeBase64Url(key.y);
    if (!key.x || !key.y || x?.length !== 32 || y?.length !== 32)
      fail('key_rejected', 'Both key coordinates must contain 32 bytes.');
    let publicKey: CryptoKey;
    try {
      publicKey = await globalThis.crypto.subtle.importKey(
        'jwk',
        { kty: 'EC', crv: 'P-256', x: key.x, y: key.y, ext: true },
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      );
    } catch {
      fail('key_rejected', 'The published coordinates are not a valid P-256 point.');
    }
    if (signatureBytes.length !== 64) fail('signature_malformed', 'P1363 signatures must contain exactly 64 bytes.');
    const base = PartnerWebhookSignatureBase.build(
      request.method,
      this.receiver.configuredUrl,
      digest,
      eventId,
      attempt,
      applicationId,
      parsed.signatureParams,
    );
    try {
      if (
        !(await globalThis.crypto.subtle.verify(
          { name: 'ECDSA', hash: 'SHA-256' },
          publicKey,
          arrayBufferOf(signatureBytes),
          arrayBufferOf(base),
        ))
      )
        fail('signature_invalid', 'The signature does not verify over the rebuilt base.');
    } catch (cause) {
      if (cause instanceof UnverifiableWebhookError) throw cause;
      fail('signature_invalid', 'The signature could not be verified.');
    }
  }

  /** Verifies first, then checks envelope bindings before parsing typed event data. */
  async verifyAndParse(request: VerifiableWebhook, options?: SigningKeyRequestOptions): Promise<WebhookEnvelope> {
    await this.verify(request, options);
    let value: Record<string, unknown>;
    let eventId: string;
    let applicationId: string;
    try {
      value = asObject(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(request.body)) as unknown,
        'WebhookEnvelope',
      );
      eventId = requiredUuid(value, 'id', 'WebhookEnvelope');
      applicationId = requiredUuid(value, 'applicationId', 'WebhookEnvelope');
      if (
        !requiredString(value, 'type', 'WebhookEnvelope') ||
        !optionalTimestamp(value, 'occurredAt', 'WebhookEnvelope')
      )
        throw new TypeError('A webhook must carry a type and occurredAt.');
      asObject(value.data, 'WebhookEnvelope.data');
    } catch {
      fail('envelope_invalid', 'The verified body is not a valid webhook envelope.');
    }
    if (eventId !== header(request, 'webhook-id', 'covered_components_mismatch'))
      fail('event_id_mismatch', 'The envelope event id differs from the signed header.');
    if (
      applicationId !== this.receiver.applicationId ||
      applicationId !== header(request, 'anis-application-id', 'covered_components_mismatch')
    )
      fail('application_id_mismatch', 'The envelope application differs from the receiver binding.');
    try {
      return parseWebhookEnvelope(value);
    } catch {
      fail('envelope_invalid', 'The verified envelope data is structurally invalid.');
    }
  }
}

function header(request: VerifiableWebhook, name: string, reason: WebhookVerificationFailure): string | undefined {
  const matches = Object.keys(request.headers).filter((key) => key.toLowerCase() === name);
  if (matches.length > 1) fail(reason, 'Duplicate HTTP fields are ambiguous.');
  const key = matches[0];
  return key === undefined ? undefined : request.headers[key];
}
function resolve(document: SigningKeySet, kid: string): PublishedSigningKey | undefined {
  return document.keys.find((key) => key.kid === kid);
}
function refuseCompromised(document: SigningKeySet, kid: string): void {
  if (document.revoked?.some((entry) => entry.kid === kid)) fail('key_compromised', 'The signing key is compromised.');
}
function fail(reason: WebhookVerificationFailure, detail: string): never {
  throw new UnverifiableWebhookError(reason, detail);
}
