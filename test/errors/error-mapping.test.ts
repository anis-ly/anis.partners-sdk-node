import { describe, expect, it } from 'vitest';
import {
  AnisApiError,
  AuthorizationError,
  DependencyUnavailableError,
  EnrollmentRefusedError,
  IdempotencyConflictError,
  InsufficientBalanceError,
  InvalidCredentialsError,
  LimitExceededError,
  OutOfStockError,
  PriceChangedError,
  RateLimitedError,
  ReplayDetectedError,
  ResourceNotFoundError,
  ValidationFailedError,
  createAnisApiError,
} from '../../src/errors/anis-api-error.js';
import type { OrderRefusalOutcome } from '../../src/errors/anis-api-error.js';
import { ERROR_CODES } from '../../src/errors/error-codes.generated.js';
import { AnisPartnersClient } from '../../src/client.js';
import { Money } from '../../src/models/money.js';
import { KeyedSigner } from '../../src/signing/keyed-signer.js';
import { signedFetchDouble } from '../support/signed-fetch.js';

type ErrorConstructor = new (
  problem: { status: number; code?: string; requestId?: string },
  status: number,
) => AnisApiError;

const decisions: Record<string, { error: ErrorConstructor; outcome: OrderRefusalOutcome }> = {
  account_inactive: { error: AuthorizationError, outcome: 'notPlaced' },
  allowed_debt_consent_required: { error: AnisApiError, outcome: 'notPlaced' },
  binding_not_authorized: { error: AuthorizationError, outcome: 'notPlaced' },
  business_subscription_required: { error: AuthorizationError, outcome: 'notPlaced' },
  card_not_found: { error: ResourceNotFoundError, outcome: 'notPlaced' },
  card_unavailable: { error: OutOfStockError, outcome: 'notPlaced' },
  challenge_expired: { error: EnrollmentRefusedError, outcome: 'notPlaced' },
  currency_not_supported: { error: ValidationFailedError, outcome: 'notPlaced' },
  daily_limit_exceeded: { error: LimitExceededError, outcome: 'notPlaced' },
  dependency_unavailable: { error: DependencyUnavailableError, outcome: 'unknown' },
  idempotency_conflict: { error: IdempotencyConflictError, outcome: 'notPlaced' },
  insufficient_balance: { error: InsufficientBalanceError, outcome: 'notPlaced' },
  insufficient_scope: { error: AuthorizationError, outcome: 'unknown' },
  internal_error: { error: DependencyUnavailableError, outcome: 'unknown' },
  invalid_content_digest: { error: AnisApiError, outcome: 'notPlaced' },
  invalid_credentials: { error: InvalidCredentialsError, outcome: 'unknown' },
  invitation_invalid: { error: EnrollmentRefusedError, outcome: 'notPlaced' },
  invoice_reveal_limit_exceeded: { error: AnisApiError, outcome: 'notPlaced' },
  key_duplicate: { error: EnrollmentRefusedError, outcome: 'notPlaced' },
  key_proof_invalid: { error: EnrollmentRefusedError, outcome: 'notPlaced' },
  malformed_signed_request: { error: AnisApiError, outcome: 'unknown' },
  operation_processing: { error: AnisApiError, outcome: 'unknown' },
  owner_limit_exceeded: { error: LimitExceededError, outcome: 'notPlaced' },
  price_changed: { error: PriceChangedError, outcome: 'notPlaced' },
  purchase_not_allowed: { error: AuthorizationError, outcome: 'notPlaced' },
  quantity_unavailable: { error: OutOfStockError, outcome: 'notPlaced' },
  rate_limited: { error: RateLimitedError, outcome: 'unknown' },
  replay_detected: { error: ReplayDetectedError, outcome: 'unknown' },
  request_timeout: { error: DependencyUnavailableError, outcome: 'unknown' },
  resource_not_found: { error: ResourceNotFoundError, outcome: 'notPlaced' },
  reveal_not_allowed: { error: AuthorizationError, outcome: 'notPlaced' },
  signature_expired: { error: InvalidCredentialsError, outcome: 'unknown' },
  source_ip_not_allowed: { error: AuthorizationError, outcome: 'notPlaced' },
  validation_failed: { error: ValidationFailedError, outcome: 'notPlaced' },
  wallet_disabled: { error: AuthorizationError, outcome: 'notPlaced' },
  wallet_expired: { error: AuthorizationError, outcome: 'notPlaced' },
  wallet_not_granted: { error: ResourceNotFoundError, outcome: 'unknown' },
};

describe('Anis API error mapping', () => {
  it('has a decision for every published error code', () => {
    expect(Object.keys(decisions).sort()).toEqual([...ERROR_CODES].sort());
  });

  it.each(Object.entries(decisions))('%s maps to its typed refusal and order outcome', (code, decision) => {
    const error = createAnisApiError(
      JSON.stringify({ type: 'about:blank', title: 't', status: 409, code, requestId: '01J9' }),
      409,
    );

    expect(error.constructor).toBe(decision.error);
    expect(error.orderOutcome).toBe(decision.outcome);
    expect(error.rawCode).toBe(code);
    expect(error.requestId).toBe('01J9');
  });

  it.each(Object.entries(decisions))(
    '%s selects its exact order outcome through the client',
    async (code, decision) => {
      const operationId = 'b26bf827-8484-44aa-987a-b033e4cfa401';
      const walletId = '2f1c8a94-6d37-4e52-b8a1-0c9e5d3f7b26';
      const cardId = '8d4b1e73-9a25-4c60-8f37-6b2e9d5a1c48';
      const fake = await signedFetchDouble(() => ({
        status: 409,
        body: JSON.stringify({ status: 409, code }),
      }));
      const client = AnisPartnersClient.create({
        options: { authority: 'https://partners.example' },
        signer: new KeyedSigner({ sign: () => Promise.resolve(new Uint8Array(64)) }, operationId),
        fetch: fake.fetcher,
      });

      const result = await client.orders.create(walletId, operationId, {
        cardId,
        quantity: 1,
        expectedUnitPrice: Money.of('1.000', 'LYD'),
        expectedTotal: Money.of('1.000', 'LYD'),
      });
      const refusal =
        result.kind === 'notPlaced' ? result.refusal : result.kind === 'unknown' ? result.cause : undefined;

      expect(result.kind).toBe(decision.outcome);
      expect(refusal?.constructor).toBe(decision.error);
      expect(result.operationId).toBe(operationId);
    },
  );

  it('treats an unknown future code as an open order', () => {
    const error = createAnisApiError('{"status":409,"code":"a_code_from_the_future"}', 409);

    expect(error.code).toBe('unknown');
    expect(error.rawCode).toBe('a_code_from_the_future');
    expect(error.orderOutcome).toBe('unknown');
    expect(error.isRetryable).toBe(false);
  });

  it.each([
    ['internal_error', 500],
    ['a_code_from_the_future', 409],
    ['replay_detected', 409],
  ])('%s becomes a closed order when marked replayed', (code, status) => {
    const headers = new Headers({ 'idempotency-replayed': 'true' });
    const error = createAnisApiError(JSON.stringify({ status, code }), status, headers);

    expect(error.isReplayed).toBe(true);
    expect(error.orderOutcome).toBe('notPlaced');
  });

  it('falls back to dependency unavailable for an unreadable signed refusal', () => {
    const error = createAnisApiError('<html>bad gateway</html>', 502);

    expect(error).toBeInstanceOf(DependencyUnavailableError);
    expect(error.status).toBe(502);
    expect(error.code).toBe('internal_error');
    expect(error.orderOutcome).toBe('unknown');
  });

  it('reads Retry-After as seconds and recognizes a replay marker case-insensitively', () => {
    const headers = new Headers({ 'retry-after': '17, 18', 'idempotency-replayed': 'FALSE, TRUE' });
    const error = createAnisApiError('{"status":409,"code":"price_changed"}', 409, headers);

    expect(error.retryAfter).toBe(17);
    expect(error.isReplayed).toBe(true);
  });
});
