import { SpanStatusCode } from '@opentelemetry/api';
import { AnisApiError, createAnisApiError } from '../errors/anis-api-error.js';
import { contentDigestOf } from '../signing/content-digest.js';
import type { RequestSigner } from '../signing/p256-signer.js';
import { PartnerRequestSigner } from '../signing/partner-request-signer.js';
import type { SignatureProfile } from '../signing/signature-profile.js';
import { PartnerResponseVerifier } from '../verification/partner-response-verifier.js';
import type { SigningKeySource } from '../verification/signing-key-source.js';
import type { ValidatedClientOptions } from '../client-options.js';
import { PARTNER_ROUTES } from './partner-routes.js';
import { RandomNonceFactory, type NonceFactory } from '../signing/nonce-factory.js';
import type { PartnerLogger } from '../observability/logger.js';
import { UnverifiableResponseError } from '../verification/unverifiable-response-error.js';
import { RequestSigningError } from '../signing/request-signing-error.js';
import { safeCounter, safeHistogram, safeLog, safeSpan, withSafeSpan } from '../internal/safe-telemetry.js';
import { MalformedResponseError } from '../errors/malformed-response-error.js';
import { SigningKeyDocumentUnavailableError } from '../errors/signing-key-document-unavailable-error.js';

/** Frozen request settings used by all route groups. */
export interface TransportOptions extends ValidatedClientOptions {
  /** Route-profile signer. */
  signer?: RequestSigner;
  /** Nonce source retained by the transport so every mutation gets a fresh replay guard. */
  nonceFactory?: NonceFactory;
  /** Injectable fetch implementation. */
  fetcher: typeof globalThis.fetch;
  /** Public response key source. */
  keySource: SigningKeySource;
  /** Optional structured diagnostics. */
  logger?: Partial<PartnerLogger>;
}

/** Shared pipeline that signs exact request bytes and verifies a complete response before parsing it. */
export class PartnerTransport {
  /** Configured bounded telemetry name for this client instance. */
  get clientName(): string {
    return this.settings.name;
  }

  private readonly requestSigner?: PartnerRequestSigner;
  private readonly verifier: PartnerResponseVerifier;
  private readonly nonceFactory: NonceFactory;

  /** Keeps request signing and response verification together so callers cannot return an unverified answer. */
  constructor(private readonly settings: TransportOptions) {
    if (settings.signer !== undefined) this.requestSigner = new PartnerRequestSigner(settings.signer);
    this.verifier = new PartnerResponseVerifier(settings.keySource, undefined, settings.logger);
    this.nonceFactory = settings.nonceFactory ?? new RandomNonceFactory();
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
    signal?: AbortSignal | undefined;
  }): Promise<{ response: Response; body: Uint8Array }> {
    return withSafeSpan(`anis.partners ${request.route}`, async (span) => {
      const started = performance.now();
      const timed = operationSignal(request.signal, this.settings.timeoutMs);
      const attributes = {
        'anis.client': this.settings.name,
        'anis.route': request.route,
        'http.request.method': request.method,
      };
      safeSpan(span, (active) => active.setAttributes(attributes));
      const operationId = request.operationId;
      if (operationId !== undefined) safeSpan(span, (active) => active.setAttribute('anis.operation_id', operationId));
      try {
        const route = PARTNER_ROUTES.find(
          (entry) => entry.template === request.route && entry.method === request.method,
        );
        if (route === undefined) {
          safeSpan(span, (active) => active.setStatus({ code: SpanStatusCode.ERROR, message: 'unknown route' }));
          throw new RequestSigningError(new Error('The route is not in the SDK route table.'));
        }
        const routeProfile = 'profile' in route ? route.profile : undefined;
        if (request.profile !== undefined && request.profile !== routeProfile) {
          safeSpan(span, (active) =>
            active.setStatus({ code: SpanStatusCode.ERROR, message: 'route profile mismatch' }),
          );
          throw new RequestSigningError(new Error('The signing profile must match the published route table.'));
        }
        const profile = routeProfile;
        let url: URL;
        try {
          url = new URL(request.path, this.settings.authority);
        } catch (cause) {
          throw new RequestSigningError(cause);
        }
        const body = request.body ?? new Uint8Array();
        const headers = new Headers();
        headers.set('Accept-Encoding', 'identity');
        if (this.settings.acceptLanguage) headers.set('Accept-Language', this.settings.acceptLanguage);
        if (request.enrollmentToken !== undefined)
          headers.set('Authorization', `Enrollment ${request.enrollmentToken}`);
        if (body.length > 0) headers.set('Content-Type', 'application/json');
        let signedIdempotencyKey: string | undefined;
        if (profile !== undefined) {
          if (this.requestSigner === undefined || this.settings.signer === undefined)
            throw new RequestSigningError(new Error('A request signer is required for this route.'));
          const now = new Date();
          const nonceValue = profile === 'SafeRead' ? undefined : this.nonceFactory.create();
          const digest = profile === 'SafeRead' ? undefined : contentDigestOf(body);
          const sigStarted = performance.now();
          let signed;
          try {
            signed = await this.requestSigner.sign(
              profile,
              {
                method: request.method,
                authority: url.host,
                path: url.pathname,
                canonicalQuery: url.search.slice(1),
                anisDate: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
                ...(digest === undefined ? {} : { contentDigest: digest }),
                ...(nonceValue === undefined ? {} : { nonce: nonceValue }),
                ...(request.operationId === undefined ? {} : { idempotencyKey: request.operationId }),
              },
              Math.floor(now.getTime() / 1000),
              Math.floor(now.getTime() / 1000) + this.settings.signatureLifetimeSeconds,
            );
            signedIdempotencyKey = signed.idempotencyKey;
          } catch (cause) {
            const error = cause instanceof RequestSigningError ? cause : new RequestSigningError(cause);
            safeLog(
              this.settings.logger,
              'warn',
              `Request signing failed: method=${request.method}, route=${request.route}.`,
              {
                eventId: 1007,
                method: request.method,
                route: request.route,
                reason: 'signing',
              },
            );
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
            safeSpan(span, (active) => active.setAttribute('error.type', 'signing'));
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
          safeLog(
            this.settings.logger,
            'debug',
            `Request signed: method=${request.method}, route=${request.route}, profile=${profile}.`,
            {
              eventId: 1000,
              method: request.method,
              route: request.route,
              profile,
              keyId: this.settings.signer.keyId,
            },
          );
          headers.set('X-Anis-Date', signed.anisDate);
          if (signed.contentDigest !== undefined) headers.set('Content-Digest', signed.contentDigest);
          if (signed.nonce !== undefined) headers.set('Nonce', signed.nonce);
          headers.set('Signature-Input', signed.signatureInput);
          headers.set('Signature', signed.signature);
        }
        const signal = timed.signal;
        if (signedIdempotencyKey !== undefined) headers.set('Idempotency-Key', signedIdempotencyKey);
        let response: Response | undefined;
        try {
          const receivedResponse = await this.settings.fetcher(url, {
            method: request.method,
            headers,
            ...(body.length === 0 ? {} : { body: Buffer.from(body) }),
            signal,
            redirect: 'manual',
          });
          response = receivedResponse;
          const contentEncoding = receivedResponse.headers.get('content-encoding');
          if (contentEncoding !== null && contentEncoding.toLowerCase() !== 'identity') {
            await cancelBody(receivedResponse);
            safeCounter('anis.partners.response.verification.failures', {
              'anis.verification.failure': 'content_digest_mismatch',
            });
            safeLog(this.settings.logger, 'error', 'Response discarded: failure=content_digest_mismatch.', {
              eventId: 1003,
              failure: 'content_digest_mismatch',
            });
            throw new UnverifiableResponseError(
              'content_digest_mismatch',
              'The response was content-encoded, so its received bytes cannot match the signed digest.',
            );
          }
          const responseBody = new Uint8Array(await receivedResponse.arrayBuffer());
          const mergedHeaders: Record<string, string> = {};
          receivedResponse.headers.forEach((value, name) => {
            mergedHeaders[name] = value;
          });
          try {
            const requestSignatureInput = headers.get('Signature-Input');
            await this.verifier.verify(
              {
                status: receivedResponse.status,
                headers: mergedHeaders,
                body: responseBody,
                ...(requestSignatureInput === null ? {} : { requestSignatureInput }),
              },
              { signal },
            );
          } catch (error) {
            if (error instanceof UnverifiableResponseError)
              safeCounter('anis.partners.response.verification.failures', {
                'anis.verification.failure': error.failure,
              });
            safeSpan(span, (active) => active.setStatus({ code: SpanStatusCode.ERROR, message: 'unverifiable' }));
            if (error instanceof UnverifiableResponseError)
              safeLog(this.settings.logger, 'error', `Response discarded: failure=${error.failure}.`, {
                eventId: 1003,
                failure: error.failure,
              });
            throw error;
          }
          safeSpan(span, (active) => active.setAttribute('http.response.status_code', receivedResponse.status));
          const requestId = receivedResponse.headers.get('x-request-id');
          if (requestId !== null) safeSpan(span, (active) => active.setAttribute('anis.request_id', requestId));
          const elapsedMs = performance.now() - started;
          safeLog(
            this.settings.logger,
            'debug',
            `Request completed: method=${request.method}, route=${request.route}, status=${String(receivedResponse.status)}, requestId=${requestId ?? 'none'}, elapsedMs=${String(elapsedMs)}.`,
            {
              eventId: 1001,
              method: request.method,
              route: request.route,
              statusCode: receivedResponse.status,
              elapsedMs,
              requestId,
            },
          );
          if (!receivedResponse.ok) {
            const refusal = createAnisApiError(responseBody, receivedResponse.status, receivedResponse.headers);
            safeSpan(span, (active) => active.setAttribute('anis.error.code', refusal.rawCode ?? refusal.code));
            safeHistogram(
              'anis.partners.request.duration',
              performance.now() - started,
              {
                ...attributes,
                'http.response.status_code': receivedResponse.status,
                'anis.error.code': refusal.rawCode ?? refusal.code,
              },
              { unit: 'ms' },
            );
            safeLog(
              this.settings.logger,
              'warn',
              `Request refused: method=${request.method}, route=${request.route}, status=${String(receivedResponse.status)}, code=${refusal.rawCode ?? refusal.code}, requestId=${refusal.requestId ?? 'none'}, retryable=${String(refusal.isRetryable)}, replayed=${String(refusal.isReplayed)}.`,
              {
                eventId: 1002,
                method: request.method,
                route: request.route,
                code: refusal.rawCode ?? refusal.code,
                statusCode: receivedResponse.status,
                requestId: refusal.requestId,
                retryable: refusal.isRetryable,
                replayed: refusal.isReplayed,
              },
            );
            throw refusal;
          }
          safeHistogram(
            'anis.partners.request.duration',
            performance.now() - started,
            {
              ...attributes,
              'http.response.status_code': receivedResponse.status,
            },
            { unit: 'ms' },
          );
          return { response: receivedResponse, body: responseBody };
        } catch (error) {
          if (response !== undefined) await cancelBody(response);
          if (error instanceof AnisApiError) {
            safeSpan(span, (active) => active.setAttribute('anis.error.code', error.rawCode ?? error.code));
            safeSpan(span, (active) =>
              active.setStatus({ code: SpanStatusCode.ERROR, message: error.rawCode ?? error.code }),
            );
            throw error;
          }
          const reason =
            error instanceof UnverifiableResponseError
              ? 'unverifiable'
              : error instanceof SigningKeyDocumentUnavailableError
                ? 'connection'
                : request.signal?.aborted
                  ? 'canceled'
                  : signal.aborted
                    ? 'timeout'
                    : error instanceof TypeError
                      ? 'connection'
                      : 'other';
          safeSpan(span, (active) => active.setStatus({ code: SpanStatusCode.ERROR, message: reason }));
          safeSpan(span, (active) => active.setAttribute('error.type', reason));
          safeHistogram(
            'anis.partners.request.duration',
            performance.now() - started,
            {
              ...attributes,
              'error.type': reason,
            },
            { unit: 'ms' },
          );
          safeLog(
            this.settings.logger,
            'warn',
            `No usable answer: method=${request.method}, route=${request.route}, reason=${reason}.`,
            {
              eventId: 1007,
              method: request.method,
              route: request.route,
              elapsedMs: performance.now() - started,
              reason,
            },
          );
          throw error;
        }
      } finally {
        timed.dispose();
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
    try {
      const decoded: unknown = JSON.parse(new TextDecoder().decode(result.body));
      if (decoded === null) throw new MalformedResponseError('JSON object');
      return parse(decoded);
    } catch (error) {
      if (error instanceof MalformedResponseError) throw error;
      if (error instanceof AnisApiError) throw error;
      throw new MalformedResponseError('response model');
    }
  }

  /** Records the closed order outcome without attaching credential data to logs. */
  reportOrderOutcome(operationId: string, outcome: string, reason?: string): void {
    const message =
      outcome === 'unknown'
        ? `Order outcome unknown: operationId=${operationId}, reason=${reason ?? 'unspecified'}; resume the same id.`
        : `Order outcome ${outcome}: operationId=${operationId}.`;
    safeLog(this.settings.logger, outcome === 'unknown' ? 'warn' : 'info', message, {
      eventId: outcome === 'unknown' ? 1008 : 1004,
      operationId,
      outcome,
      ...(reason === undefined ? {} : { reason }),
    });
  }
}

function operationSignal(caller: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abortFromCaller = () => {
    controller.abort(caller?.reason);
  };
  caller?.addEventListener('abort', abortFromCaller, { once: true });
  if (caller?.aborted) abortFromCaller();
  const timer = setTimeout(() => {
    controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
  }, timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      caller?.removeEventListener('abort', abortFromCaller);
    },
  };
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The discarded response cannot be used even when its stream resists cancellation.
  }
}
