import { createHash } from 'node:crypto';
import { decodeBase64Url } from '../internal/base64url.js';
import { arrayBufferOf, fixedTimeEqual } from '../internal/bytes.js';
import type { Clock } from '../internal/clock.js';
import { systemClock } from '../internal/clock.js';
import type { SigningKeySet, PublishedSigningKey } from './partner-jwk.js';
import type { SigningKeyRequestOptions, SigningKeySource } from './signing-key-source.js';
import { parseSignatureInput } from './signature-input-parser.js';
import { PartnerResponseSignatureBase } from './partner-response-signature-base.js';
import type { VerifiableResponse } from './verifiable-response.js';
import { UnverifiableResponseError } from './unverifiable-response-error.js';
import type { ResponseVerificationFailure } from './response-verification-failure.js';
import type { PartnerLogger } from '../observability/logger.js';
import { safeLog } from '../internal/safe-telemetry.js';

/**
 * Verifies a signed Partner response and rejects it on the first failed contract rule.
 *
 * @remarks Check order is security-sensitive: the received body digest is compared in fixed time before signature
 * verification, and the covered list is rebuilt rather than accepted from the response.
 */
export class PartnerResponseVerifier {
  /** Creates a verifier with key rotation and time supplied separately so neither weakens the wire checks. */
  constructor(
    private readonly keys: SigningKeySource,
    private readonly clock: Clock = systemClock,
    private readonly logger?: Partial<Pick<PartnerLogger, 'warn'>>,
  ) {}

  /** Resolves only for a verifiable response; every refusal throws so untrusted content cannot reach a caller. */
  async verify(response: VerifiableResponse, options?: SigningKeyRequestOptions): Promise<void> {
    const signatureInput = header(response, 'Signature-Input');
    const signature = header(response, 'Signature');
    if (!signatureInput || !signature) fail('signature_missing', 'The response carried no signature headers.');
    const parsed = parseSignatureInput(signatureInput);
    if (!parsed) fail('signature_malformed', 'Signature-Input could not be parsed.');
    if (parsed.label !== 'sig1' || !signature.startsWith('sig1='))
      fail('label_unexpected', 'The label is frozen at sig1 on both headers.');
    if (parsed.algorithm !== undefined && parsed.algorithm !== 'ecdsa-p256-sha256')
      fail('algorithm_not_supported', 'There is no alternate algorithm to negotiate.');
    if (parsed.tag !== 'anis-response-v2') fail('profile_unexpected', 'The response must use anis-response-v2.');
    if (Boolean(response.requestSignatureInput) !== Boolean(response.requestSignature))
      fail('covered_components_mismatch', 'Both raw request signature headers are required for request binding.');
    const digest = header(response, 'Content-Digest');
    if (
      !digest ||
      !fixedTimeEqual(
        new TextEncoder().encode(digest),
        new TextEncoder().encode(`sha-256=:${createHash('sha256').update(response.body).digest('base64')}:`),
      )
    )
      fail('content_digest_mismatch', 'The Content-Digest does not describe the body.');
    const requestId = header(response, 'X-Request-Id');
    if (!requestId) fail('covered_components_mismatch', 'The response carried no X-Request-Id.');
    const components = PartnerResponseSignatureBase.components(
      response.status,
      digest,
      requestId,
      response.requestSignatureInput,
      response.requestSignature,
      header(response, 'Location'),
      header(response, 'Retry-After'),
      header(response, 'Idempotency-Replayed'),
      header(response, 'Cache-Control'),
    );
    const expected = components.map((part) => `${part.name}${part.requestBound ? ';req' : ''}`);
    if (expected.length !== parsed.identifiers.length || expected.some((part, i) => part !== parsed.identifiers[i]))
      fail('covered_components_mismatch', 'The advertised components differ from the frozen response profile.');
    if (parsed.identifiers.some((id) => id.endsWith(';req')) && !response.requestSignatureInput)
      fail('covered_components_mismatch', 'The request binding cannot be rebuilt.');
    const age = Math.floor(this.clock.now().getTime() / 1000) - parsed.created;
    if (!Number.isFinite(age) || Math.abs(age) > PartnerResponseSignatureBase.MAX_AGE_SECONDS)
      fail('created_out_of_window', `created is ${String(age)}s from this clock.`);

    let document = await this.keys.get(options);
    if (document.revoked?.some((entry) => entry.kid === parsed.keyId))
      fail('key_compromised', 'The response key is compromised.');
    let key = resolve(document, parsed.keyId);
    if (!key) {
      safeLog(this.logger, 'warn', 'Anis response used an unpublished signing key', {
        keyId: parsed.keyId,
        eventId: 1006,
      });
      document = await this.keys.refresh(options);
      if (document.revoked?.some((entry) => entry.kid === parsed.keyId))
        fail('key_compromised', 'The response key is compromised.');
      key = resolve(document, parsed.keyId);
    }
    if (document.keys.some((candidate) => candidate.d !== undefined && candidate.d !== ''))
      fail('key_rejected', 'The published key document carries a private member.');
    if (!key) fail('unknown_key', `keyid ${parsed.keyId} is not published.`);
    if (key.status !== 'active' && key.status !== 'next' && key.status !== 'retired')
      fail('key_rejected', 'The published key has no supported lifecycle status.');
    const notBefore = Date.parse(key.notBefore ?? '');
    if (!Number.isFinite(notBefore)) fail('key_rejected', 'The published key has no valid notBefore instant.');
    const retiredAt = Date.parse(key.retiredAt ?? '');
    if (key.status === 'retired' && !Number.isFinite(retiredAt))
      fail('key_rejected', 'The retired key has no valid retiredAt instant.');
    if (key.status === 'retired' && parsed.created * 1000 > retiredAt)
      fail('key_retired', 'The signature was created after the key retired.');
    if (key.status === 'next' && parsed.created * 1000 < notBefore)
      fail('key_not_yet_valid', 'The signature predates the next key activation.');
    const signatureBytes = byteSequence(signature);
    if (signatureBytes?.length !== 64) fail('signature_malformed', 'P-256 P1363 signatures must be exactly 64 bytes.');
    const x = decodeBase64Url(key.x);
    const y = decodeBase64Url(key.y);
    if (!x || !y || x.length !== 32 || y.length !== 32)
      fail('key_rejected', 'The published key must have two 32-byte P-256 coordinates.');
    let publicKey: CryptoKey;
    const keyX = key.x;
    const keyY = key.y;
    if (!keyX || !keyY) fail('key_rejected', 'The published key has missing coordinates.');
    try {
      publicKey = await globalThis.crypto.subtle.importKey(
        'jwk',
        { kty: 'EC', crv: 'P-256', x: keyX, y: keyY, ext: true },
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      );
    } catch {
      fail('key_rejected', 'The published coordinates are not a valid P-256 point.');
    }
    const base = PartnerResponseSignatureBase.build(components, parsed.created, parsed.keyId);
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
      if (cause instanceof UnverifiableResponseError) throw cause;
      fail('signature_invalid', 'The signature could not be verified over the rebuilt base.');
    }
  }
}

function header(response: VerifiableResponse, name: string): string | undefined {
  for (const key of Object.keys(response.headers))
    if (key.toLowerCase() === name.toLowerCase()) return response.headers[key];
  return undefined;
}
function resolve(document: SigningKeySet, keyId: string): PublishedSigningKey | undefined {
  return document.keys.find((key) => key.kid === keyId && key.x && key.y);
}
function byteSequence(value: string): Uint8Array | undefined {
  const match = /^sig1=:([A-Za-z0-9+/]+={0,2}):$/.exec(value);
  if (!match) return undefined;
  const encoded = match[1];
  if (encoded === undefined) return undefined;
  try {
    const bytes = Buffer.from(encoded, 'base64');
    return bytes.toString('base64') === encoded ? new Uint8Array(bytes) : undefined;
  } catch {
    return undefined;
  }
}
function fail(reason: ResponseVerificationFailure, detail: string): never {
  throw new UnverifiableResponseError(reason, detail);
}
