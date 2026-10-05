import { SpanStatusCode } from '@opentelemetry/api';
import { AnisApiError, createAnisApiError } from '../errors/anis-api-error.js';
import { contentDigestOf } from '../signing/content-digest.js';
import type { RequestSigner } from '../signing/p256-signer.js';
import { canonicalizeSignatureInputs } from '../signing/signature-inputs.js';
import { PartnerRequestSigner } from '../signing/partner-request-signer.js';
import type { SignatureProfile } from '../signing/signature-profile.js';
import { PartnerResponseVerifier } from '../verification/partner-response-verifier.js';
import type { SigningKeySource } from '../verification/signing-key-source.js';
import type { ValidatedClientOptions } from '../client-options.js';
import { PARTNER_ROUTES } from './partner-routes.js';
import { RandomNonceFactory } from '../signing/nonce-factory.js';
import type { PartnerLogger } from '../observability/logger.js';
import { UnverifiableResponseError } from '../verification/unverifiable-response-error.js';
import { safeCounter, safeHistogram, safeLog, safeSpan, withSafeSpan } from '../internal/safe-telemetry.js';

/** Frozen request settings used by all route groups. */
export interface TransportOptions extends ValidatedClientOptions {
  /** Route-profile signer. */
  signer: RequestSigner;
  /** Injectable fetch implementation. */
  fetcher: typeof globalThis.fetch;
  /** Public response key source. */
  keySource: SigningKeySource;
  /** Optional structured diagnostics. */
  logger?: PartnerLogger;
}

/** Shared pipeline that signs exact request bytes and verifies a complete response before parsing it. */
export class PartnerTransport {
  private readonly requestSigner: PartnerRequestSigner;
  private readonly verifier: PartnerResponseVerifier;

  /** Creates the mandatory sign/send/verify pipeline. */
  constructor(private readonly settings: TransportOptions) {
    this.requestSigner = new PartnerRequestSigner(settings.signer);
    this.verifier = new PartnerResponseVerifier(settings.keySource, undefined, settings.logger);
  }

  /** Sends one API request; response data is not parsed until its signature and digest pass. */
  async send(request: {
    method: string;
    route: string;
    path: string;
    profile?: SignatureProfile;
    body?: Uint8Array;
    operationId?: string;
    enrollmentToken?: string;
    signal?: AbortSignal;
  }): Promise<{ response: Response; body: Uint8Array }> {
    return withSafeSpan(`anis.partners ${request.route}`, async (span) => {
      const started = performance.now();
      const attributes = {
        'anis.client': 'default',
        'anis.route': request.route,
        'http.request.method': request.method,
        ...(request.operationId === undefined ? {} : { 'anis.operation_id': request.operationId }),
      };
      safeSpan(span, (active) => active.setAttributes(attributes));
      const route = PARTNER_ROUTES.find((entry) => entry.template === request.route && entry.method === request.method);
      if (route === undefined) {
        safeSpan(span, (active) => active.setStatus({ code: SpanStatusCode.ERROR, message: 'unknown route' }));
        throw new TypeError(`The route ${request.route} is not in the SDK route table.`);
      }
      const routeProfile = 'profile' in route ? route.profile : undefined;
      if (request.profile !== undefined && request.profile !== routeProfile) {
        safeSpan(span, (active) => active.setStatus({ code: SpanStatusCode.ERROR, message: 'route profile mismatch' }));
        throw new TypeError('The signing profile must match the published route table.');
      }
      const profile = routeProfile;
      const url = new URL(request.path, this.settings.authority);
      const body = request.body ?? new Uint8Array();
      const headers = new Headers();
      headers.set('Accept-Encoding', 'identity');
      if (this.settings.acceptLanguage) headers.set('Accept-Language', this.settings.acceptLanguage);
      if (request.enrollmentToken !== undefined) headers.set('Authorization', `Enrollment ${request.enrollmentToken}`);
      if (body.length > 0) headers.set('Content-Type', 'application/json');
      if (profile !== undefined) {
        const now = new Date();
        const nonceValue = profile === 'SafeRead' ? undefined : new RandomNonceFactory().create();
        const digest = profile === 'SafeRead' ? undefined : contentDigestOf(body);
        if (request.operationId !== undefined) headers.set('Idempotency-Key', request.operationId);
        const sigStarted = performance.now();
        let signed;
        try {
          signed = await this.requestSigner.sign(
            profile,
            canonicalizeSignatureInputs({
              method: request.method,
              authority: url.host,
              path: url.pathname,
              canonicalQuery: url.search.slice(1),
              anisDate: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
              ...(digest === undefined ? {} : { contentDigest: digest }),
              ...(nonceValue === undefined ? {} : { nonce: nonceValue }),
              ...(request.operationId === undefined ? {} : { idempotencyKey: request.operationId }),
            }),
            Math.floor(now.getTime() / 1000),
            Math.floor(now.getTime() / 1000) + this.settings.signatureLifetimeSeconds,
          );
        } catch (error) {
          safeHistogram(
            'anis.partners.signature.duration',
            performance.now() - sigStarted,
            {
              'anis.signature.profile': profile,
            },
            { unit: 'ms' },
          );
          safeLog(this.settings.logger, 'warn', 'Anis request could not be signed', {
            eventId: 1007,
            method: request.method,
            route: request.route,
            reason: 'signing',
          });
          safeHistogram(
            'anis.partners.request.duration',
            performance.now() - started,
            {
              ...attributes,
              'error.type': 'signing',
            },
            { unit: 'ms' },
          );
          safeSpan(span, (active) => active.setStatus({ code: SpanStatusCode.ERROR, message: 'signing' }));
          throw error;
        }
        safeHistogram(
          'anis.partners.signature.duration',
          performance.now() - sigStarted,
          {
            'anis.signature.profile': profile,
          },
          { unit: 'ms' },
        );
        safeLog(this.settings.logger, 'debug', 'Anis request signed', {
          eventId: 1000,
          method: request.method,
          route: request.route,
          profile,
          keyId: this.settings.signer.keyId,
        });
        headers.set('X-Anis-Date', signed.anisDate);
        if (signed.contentDigest !== undefined) headers.set('Content-Digest', signed.contentDigest);
        if (signed.nonce !== undefined) headers.set('Nonce', signed.nonce);
        headers.set('Signature-Input', signed.signatureInput);
        headers.set('Signature', signed.signature);
      }
      const signals = [AbortSignal.timeout(this.settings.timeoutMs)];
      if (request.signal !== undefined) signals.push(request.signal);
      const signal = AbortSignal.any(signals);
      try {
        const response = await this.settings.fetcher(url, {
          method: request.method,
          headers,
          ...(body.length === 0 ? {} : { body: Buffer.from(body) }),
          signal,
          redirect: 'manual',
        });
        const contentEncoding = response.headers.get('content-encoding');
        if (contentEncoding !== null && contentEncoding.toLowerCase() !== 'identity')
          throw new UnverifiableResponseError(
            'content_digest_mismatch',
            'The response was content-encoded, so its received bytes cannot match the signed digest.',
          );
        const responseBody = new Uint8Array(await response.arrayBuffer());
        const mergedHeaders: Record<string, string> = {};
        response.headers.forEach((value, name) => {
          mergedHeaders[name] = value;
        });
        {
          try {
            const requestSignatureInput = headers.get('Signature-Input');
            await this.verifier.verify(
              {
                status: response.status,
                headers: mergedHeaders,
                body: responseBody,
                ...(requestSignatureInput === null ? {} : { requestSignatureInput }),
              },
              { signal },
            );
          } catch (error) {
            safeCounter('anis.partners.response.verification.failures', {
              'anis.verification.failure':
                error instanceof UnverifiableResponseError ? error.failure : 'signature_invalid',
            });
            safeSpan(span, (active) => active.setStatus({ code: SpanStatusCode.ERROR, message: 'unverifiable' }));
            safeLog(this.settings.logger, 'error', 'Anis response discarded', {
              eventId: 1003,
              failure: error instanceof UnverifiableResponseError ? error.failure : 'signature_invalid',
            });
            throw error;
          }
        }
        safeSpan(span, (active) => active.setAttribute('http.response.status_code', response.status));
        const requestId = response.headers.get('x-request-id');
        if (requestId !== null) safeSpan(span, (active) => active.setAttribute('anis.request_id', requestId));
        safeLog(this.settings.logger, 'debug', 'Anis request completed', {
          eventId: 1001,
          method: request.method,
          route: request.route,
          statusCode: response.status,
          elapsedMs: performance.now() - started,
          requestId,
        });
        if (!response.ok) {
          const refusal = createAnisApiError(responseBody, response.status, response.headers);
          safeSpan(span, (active) => active.setAttribute('anis.error.code', refusal.rawCode ?? refusal.code));
          safeHistogram(
            'anis.partners.request.duration',
            performance.now() - started,
            {
              ...attributes,
              'http.response.status_code': response.status,
              'anis.error.code': refusal.rawCode ?? refusal.code,
            },
            { unit: 'ms' },
          );
          safeLog(this.settings.logger, 'warn', 'Anis refused the request', {
            eventId: 1002,
            method: request.method,
            route: request.route,
            code: refusal.rawCode ?? refusal.code,
            statusCode: response.status,
            requestId: refusal.requestId,
            retryable: refusal.isRetryable,
            replayed: refusal.isReplayed,
          });
          throw refusal;
        }
        safeHistogram(
          'anis.partners.request.duration',
          performance.now() - started,
          {
            ...attributes,
            'http.response.status_code': response.status,
          },
          { unit: 'ms' },
        );
        return { response, body: responseBody };
      } catch (error) {
        if (error instanceof AnisApiError) {
          safeSpan(span, (active) => active.setAttribute('anis.error.code', error.rawCode ?? error.code));
          safeSpan(span, (active) =>
            active.setStatus({ code: SpanStatusCode.ERROR, message: error.rawCode ?? error.code }),
          );
          throw error;
        }
        const reason =
          error instanceof Error && 'failure' in error
            ? 'unverifiable'
            : request.signal?.aborted
              ? 'canceled'
              : signal.aborted
                ? 'timeout'
                : error instanceof TypeError
                  ? 'connection'
                  : 'other';
        safeSpan(span, (active) => active.setStatus({ code: SpanStatusCode.ERROR, message: reason }));
        safeHistogram(
          'anis.partners.request.duration',
          performance.now() - started,
          {
            ...attributes,
            'error.type': reason,
          },
          { unit: 'ms' },
        );
        if (!(error instanceof AnisApiError)) {
          safeLog(this.settings.logger, 'warn', 'Anis request ended without a usable answer', {
            eventId: 1007,
            method: request.method,
            route: request.route,
            elapsedMs: performance.now() - started,
            reason,
          });
        }
        throw error;
      } finally {
        safeSpan(span, (active) => {
          active.end();
        });
      }
    });
  }

  /** Sends and parses a verified non-empty JSON success. */
  async json<T>(request: Parameters<PartnerTransport['send']>[0], parse: (value: unknown) => T): Promise<T> {
    const result = await this.send(request);
    if (result.body.length === 0)
      throw new AnisApiError(
        { status: result.response.status, code: 'internal_error', title: 'Empty body' },
        result.response.status,
      );
    const decoded: unknown = JSON.parse(new TextDecoder().decode(result.body));
    if (decoded === null)
      throw new AnisApiError(
        { status: result.response.status, code: 'internal_error', title: 'Empty body' },
        result.response.status,
      );
    return parse(decoded);
  }

  /** Records the closed order outcome without attaching credential data to logs. */
  reportOrderOutcome(operationId: string, outcome: string, reason?: string): void {
    safeLog(
      this.settings.logger,
      'info',
      outcome === 'unknown'
        ? 'Anis order outcome is unknown; resume with the same operation id, never a new one.'
        : `Anis order outcome: ${outcome}`,
      {
        eventId: outcome === 'unknown' ? 1008 : 1004,
        operationId,
        outcome,
        ...(reason === undefined ? {} : { reason }),
      },
    );
  }

  /** Emits the key-refresh warning without publishing response contents or signatures. */
  reportUnknownSigningKey(keyId: string): void {
    safeLog(this.settings.logger, 'warn', 'Anis response used a signing key this client has not seen', {
      eventId: 1006,
      keyId,
    });
  }
}
