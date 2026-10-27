import { AnisApiError, refusedAtTheDoor } from '../errors/anis-api-error.js';
import type { ErrorCode } from '../errors/error-codes.generated.js';
import { MalformedResponseError } from '../errors/malformed-response-error.js';
import { SigningKeyDocumentUnavailableError } from '../errors/signing-key-document-unavailable-error.js';
import { safeCounter } from '../internal/safe-telemetry.js';
import { retryAfterSeconds } from '../internal/retry-after.js';
import { RequestSigningError } from '../signing/request-signing-error.js';
import { UnverifiableResponseError } from '../verification/unverifiable-response-error.js';
import type { CallOptions } from './operations.js';
import type { PartnerTransport } from './partner-transport.js';

interface Unresolved {
  kind: 'unknown';
  operationId: string;
  suggestedDelayMs: number;
  cause: unknown;
}
interface Refused {
  kind: 'notPlaced';
  operationId: string;
  refusal: AnisApiError;
}
interface Observed<T> {
  kind: 'processing' | 'final';
  operationId: string;
  value: T;
  suggestedDelayMs: number;
  location?: string;
}
/** Delay before resuming a processing answer: the signed Retry-After seconds, otherwise five seconds. */
export function processingDelayMs(response: Response): number {
  return (retryAfterSeconds(response.headers.get('retry-after')) ?? 5) * 1000;
}

/** Shared product recovery path; it sends once and leaves reconciliation to the gateway. */
export async function sendProduct<A extends { operationId: string }, T extends { operationId: string }>(
  transport: PartnerTransport,
  input: {
    route: string;
    path: string;
    operationId: string;
    body: Uint8Array;
    resuming: boolean;
    accepted: (value: unknown) => A;
    read: (value: unknown) => T;
    final: (value: T) => boolean;
  },
  options?: CallOptions,
): Promise<Unresolved | Refused | Observed<A | T>> {
  const operationId = input.operationId;
  let result: Unresolved | Refused | Observed<A | T>;
  let cancellation: unknown;
  let rethrow = false;
  let reason: string | undefined;
  try {
    const { response, body } = await transport.send({
      method: 'POST',
      route: input.route,
      path: input.path,
      profile: 'OrderMutation',
      operationId,
      body: input.body,
      signal: options?.signal,
    });
    let value: A | T;
    let final = false;
    try {
      if (body.length === 0) throw new TypeError('Missing response body.');
      const decoded: unknown = JSON.parse(new TextDecoder().decode(body));
      if (response.status === 202) value = input.accepted(decoded);
      else if (response.status === 200 || response.status === 201) {
        const read = input.read(decoded);
        value = read;
        final = input.final(read);
      } else throw new TypeError('Unexpected product response status.');
      if (value.operationId !== operationId) throw new TypeError('Mismatched operation id.');
    } catch {
      throw new MalformedResponseError('product response');
    }
    const location = response.headers.get('location');
    result = {
      kind: final ? 'final' : 'processing',
      operationId,
      value,
      suggestedDelayMs: processingDelayMs(response),
      ...(location === null ? {} : { location }),
    };
  } catch (error) {
    if (error instanceof RequestSigningError) throw error;
    if (error instanceof AnisApiError) {
      // Product refusal classification does not depend on card credential-release rules.
      const definitive = definitiveRefusal(error.code);
      if (definitive && (!input.resuming || error.isReplayed))
        result = { kind: 'notPlaced', operationId, refusal: error };
      else {
        reason = error.rawCode ?? 'refused';
        result = {
          kind: 'unknown',
          operationId,
          cause: error,
          suggestedDelayMs:
            error.retryAfter === undefined ? (refusedAtTheDoor(error.code) ? 60_000 : 5000) : error.retryAfter * 1000,
        };
      }
    } else {
      reason = options?.signal?.aborted ? 'canceled' : errorReason(error);
      result = { kind: 'unknown', operationId, cause: error, suggestedDelayMs: 5000 };
      rethrow = options?.signal?.aborted ?? false;
      cancellation = error;
    }
  }
  if (result.kind !== 'notPlaced') {
    safeCounter('anis.partners.order.outcomes', {
      'anis.client': transport.clientName,
      'anis.order.outcome': result.kind,
      ...(reason === undefined ? {} : { 'error.type': reason }),
    });
    transport.reportOrderOutcome(operationId, result.kind, reason);
  }
  if (rethrow) throw cancellation;
  return result;
}
// `idempotency_conflict` is deliberately absent: the id may already be accepted and charged, so the partner reads it first.
const DEFINITIVE_REFUSALS = new Set<ErrorCode>([
  'meter_rejected',
  'package_unavailable',
  'direct_recharge_product_unavailable',
  'amount_out_of_range',
  'price_changed',
  'insufficient_balance',
  'spending_limit_exceeded',
  'daily_limit_exceeded',
  'owner_limit_exceeded',
  'validation_failed',
  'currency_not_supported',
  'purchase_not_allowed',
  'allowed_debt_consent_required',
  'wallet_disabled',
  'wallet_expired',
  'business_subscription_required',
  'account_inactive',
  'binding_not_authorized',
]);
function definitiveRefusal(code: ErrorCode): boolean {
  return DEFINITIVE_REFUSALS.has(code);
}
function errorReason(error: unknown): string {
  if (error instanceof UnverifiableResponseError) return 'unverifiable';
  if (error instanceof SigningKeyDocumentUnavailableError || error instanceof TypeError) return 'connection';
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'timeout';
  return 'other';
}
/** Serializes only a projected request object, before any network send. */
export function productBody(value: () => unknown): Uint8Array {
  try {
    return new TextEncoder().encode(JSON.stringify(value()));
  } catch (cause) {
    throw new RequestSigningError(cause);
  }
}
