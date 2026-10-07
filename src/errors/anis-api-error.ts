import { parseErrorCode, RETRYABLE_ERROR_CODES, type ErrorCode } from './error-codes.generated.js';
import { parseProblem, type Problem } from '../models/problem.js';
import { AnisPartnersError } from './anis-partners-error.js';
import { retryAfterSeconds } from '../internal/retry-after.js';

/** Whether Anis's refusal means the order is closed or may still complete. */
export type OrderRefusalOutcome = 'notPlaced' | 'unknown';

/** An Anis API refusal with stable machine fields for partner-side branching. */
export class AnisApiError extends AnisPartnersError {
  /** Complete parsed problem returned by Anis. */
  readonly problem: Problem;
  /** Known machine code, or unknown when this SDK has not seen the value. */
  readonly code: ErrorCode;
  /** Exact wire code, including an unknown future value. */
  readonly rawCode?: string;
  /** HTTP status of the response, verified first when the route's answers are signed. */
  readonly status: number;
  /** Correlation id to quote when asking Anis about the call. */
  readonly requestId?: string;
  /** Permanent documentation link for this code. */
  readonly typeUri?: string;
  /** Retry-After value in seconds, when supplied; covered by the signature on a signed route. */
  readonly retryAfter?: number;
  /** True when Anis returned the recorded refusal for this operation id. */
  readonly isReplayed: boolean;
  /** Whether the catalogue marks this code retryable; this does not decide order recovery. */
  readonly isRetryable: boolean;
  /** Whether the refusal leaves an order open for resume. */
  readonly orderOutcome: OrderRefusalOutcome;

  /**
   * Creates a structured API error from a received problem, verified first when the route's answers are signed.
   *
   * @remarks The code is the stable branching contract. Titles and details change with language and copy updates, so
   * callers that branch on the message can break without any API behavior changing.
   */
  constructor(problem: Problem, status: number, retryAfter?: number, isReplayed = false) {
    super(
      `Anis returned ${String(status)} ${problem.code ?? 'unknown'}${isReplayed ? ' (recorded answer for this operation)' : ''}${problem.requestId === undefined ? '' : ` (request ${problem.requestId})`}. Branch on the code, not on this message.`,
    );
    this.problem = problem;
    Object.defineProperty(this, 'problem', { enumerable: false });
    this.status = status;
    this.code = parseErrorCode(problem.code);
    this.isReplayed = isReplayed;
    this.isRetryable = RETRYABLE_ERROR_CODES.has(this.code);
    this.orderOutcome = isReplayed ? 'notPlaced' : outcomeOf(this.code);
    if (problem.code !== undefined) {
      this.rawCode = problem.code;
    }
    if (problem.requestId !== undefined) {
      this.requestId = problem.requestId;
    }
    if (problem.type !== undefined) {
      this.typeUri = problem.type;
    }
    if (retryAfter !== undefined) {
      this.retryAfter = retryAfter;
    }
  }
}

/** A final refusal because the wallet balance cannot cover the order. */
export class InsufficientBalanceError extends AnisApiError {}
/** A final refusal because the catalogue price changed after it was read. */
export class PriceChangedError extends AnisApiError {}
/** A final refusal because the card or requested quantity is unavailable. */
export class OutOfStockError extends AnisApiError {}
/** A final refusal because an operation id was reused for a different order. */
export class IdempotencyConflictError extends AnisApiError {}
/** A request-rate refusal; callers should honor Retry-After when present. */
export class RateLimitedError extends AnisApiError {}
/** A final refusal because an owner spending allowance is exhausted. */
export class LimitExceededError extends AnisApiError {}
/** A refusal because the signing credentials are not accepted. */
export class InvalidCredentialsError extends AnisApiError {}
/** A refusal because the same signed nonce was already received. */
export class ReplayDetectedError extends AnisApiError {}
/** A refusal because current application or owner policy does not allow the call. */
export class AuthorizationError extends AnisApiError {}
/** A refusal for a resource that is absent or intentionally indistinguishable from absent. */
export class ResourceNotFoundError extends AnisApiError {}
/** A refusal because the request does not satisfy the published contract. */
export class ValidationFailedError extends AnisApiError {}
/** A refusal where Anis could not reach a decision; an order may still complete. */
export class DependencyUnavailableError extends AnisApiError {}
/** A refusal of an invitation, key submission, or enrollment proof step. */
export class EnrollmentRefusedError extends AnisApiError {}

/** Classifies an error code before applying the create-versus-resume rule. */
export function outcomeOf(code: ErrorCode): OrderRefusalOutcome {
  return code === 'dependency_unavailable' ||
    code === 'request_timeout' ||
    code === 'internal_error' ||
    code === 'operation_processing' ||
    code === 'replay_detected' ||
    code === 'rate_limited' ||
    code === 'unknown' ||
    refusedAtTheDoor(code)
    ? 'unknown'
    : 'notPlaced';
}

/** Reports a refusal decided before Anis looks up an order, which can leave an earlier attempt unresolved. */
export function refusedAtTheDoor(code: ErrorCode): boolean {
  return (
    code === 'invalid_credentials' ||
    code === 'signature_expired' ||
    code === 'insufficient_scope' ||
    code === 'wallet_not_granted' ||
    code === 'malformed_signed_request'
  );
}

/**
 * Parses a refusal and attaches typed errors for the cases partners commonly handle differently.
 *
 * @remarks The transport calls this only after a signed route's refusal has verified; an information route's refusal
 * is unsigned and maps the same way.
 */
export function createAnisApiError(body: Uint8Array | string, status: number, headers?: Headers): AnisApiError {
  const problem = parseProblemOrFallback(body, status);
  const retryAfter = retryAfterSeconds(headers?.get('retry-after'));
  const isReplayed = headerValues(headers?.get('idempotency-replayed')).some((value) => value.toLowerCase() === 'true');
  const ErrorType = errorTypeFor(problem.code);
  return new ErrorType(problem, status, retryAfter, isReplayed);
}

function parseProblemOrFallback(body: Uint8Array | string, status: number): Problem {
  try {
    const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
    return parseProblem(JSON.parse(text) as unknown);
  } catch {
    return { type: 'about:blank', title: 'Unreadable problem', status, code: 'internal_error' };
  }
}

function headerValues(value: string | null | undefined): string[] {
  return value === undefined || value === null ? [] : value.split(',').map((part) => part.trim());
}

function errorTypeFor(code: string | undefined): typeof AnisApiError {
  switch (parseErrorCode(code)) {
    case 'insufficient_balance':
      return InsufficientBalanceError;
    case 'price_changed':
      return PriceChangedError;
    case 'quantity_unavailable':
    case 'card_unavailable':
      return OutOfStockError;
    case 'idempotency_conflict':
      return IdempotencyConflictError;
    case 'rate_limited':
      return RateLimitedError;
    case 'owner_limit_exceeded':
    case 'daily_limit_exceeded':
      return LimitExceededError;
    case 'invalid_credentials':
    case 'signature_expired':
      return InvalidCredentialsError;
    case 'replay_detected':
      return ReplayDetectedError;
    case 'insufficient_scope':
    case 'source_ip_not_allowed':
    case 'binding_not_authorized':
    case 'account_inactive':
    case 'business_subscription_required':
    case 'wallet_disabled':
    case 'wallet_expired':
    case 'purchase_not_allowed':
    case 'reveal_not_allowed':
      return AuthorizationError;
    case 'resource_not_found':
    case 'card_not_found':
    case 'wallet_not_granted':
      return ResourceNotFoundError;
    case 'validation_failed':
    case 'currency_not_supported':
      return ValidationFailedError;
    case 'dependency_unavailable':
    case 'request_timeout':
    case 'internal_error':
      return DependencyUnavailableError;
    case 'invitation_invalid':
    case 'challenge_expired':
    case 'key_proof_invalid':
    case 'key_duplicate':
      return EnrollmentRefusedError;
    default:
      return AnisApiError;
  }
}
