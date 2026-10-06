# Errors

## Branch on the code

For a read, catch `AnisApiError` and use `code`, `status`, `requestId`, `retryAfter`, `isRetryable`, `isReplayed`, `orderOutcome`, and `rawCode`. The message, title, and detail are presentation text; they may change with language or copy updates.

```ts
import { AnisApiError, AnisPartnersClient, PemP256Signer } from '@anis-ly/partners';

const setting = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
};
const signer = (await PemP256Signer.fromPemFile('/secure/partner-key.pem')).forKey(setting('SAMPLE_KEY_ID'));
const client = AnisPartnersClient.create({ options: { authority: setting('ANIS_PARTNERS_AUTHORITY') }, signer });
const logger = { warn: (message: string, fields: Record<string, unknown>) => console.warn(message, fields) };

try {
  await client.profile.get();
} catch (error) {
  if (!(error instanceof AnisApiError)) throw error;
  logger.warn('Partner API refusal', {
    code: error.code,
    status: error.status,
    requestId: error.requestId,
    retryable: error.isRetryable,
    replayed: error.isReplayed,
  });
}
```

Order refusals are values: `notPlaced` carries the typed `refusal`; unresolved refusals are carried as the `cause` of `unknown`. `unknown` means resume the same operation id. An unknown future code is available as `code: 'unknown'` and its wire spelling remains in `rawCode`.

## Public codes

This table is generated from `contracts/error-catalogue.json`. “Order placed?” describes the safe order action: an uncertain answer must be resumed with the same id.

| Code                             |      HTTP | Typed error                  | Retryable | Order placed?                  |
| -------------------------------- | --------: | ---------------------------- | --------- | ------------------------------ |
| `invalid_credentials`            |       401 | `InvalidCredentialsError`    | No        | May be unknown; resume same id |
| `signature_expired`              |       401 | `InvalidCredentialsError`    | Yes       | May be unknown; resume same id |
| `invalid_content_digest`         |       400 | `AnisApiError`               | No        | No; final refusal              |
| `malformed_signed_request`       |       400 | `AnisApiError`               | No        | May be unknown; resume same id |
| `replay_detected`                |       409 | `ReplayDetectedError`        | Yes       | May be unknown; resume same id |
| `source_ip_not_allowed`          |       403 | `AuthorizationError`         | No        | No; final refusal              |
| `insufficient_scope`             |       403 | `AuthorizationError`         | No        | May be unknown; resume same id |
| `binding_not_authorized`         |       403 | `AuthorizationError`         | No        | No; final refusal              |
| `resource_not_found`             |       404 | `ResourceNotFoundError`      | No        | No; final refusal              |
| `card_not_found`                 |       404 | `ResourceNotFoundError`      | No        | No; final refusal              |
| `wallet_not_granted`             |       404 | `ResourceNotFoundError`      | No        | May be unknown; resume same id |
| `validation_failed`              |       422 | `ValidationFailedError`      | No        | No; final refusal              |
| `idempotency_conflict`           |       409 | `IdempotencyConflictError`   | No        | No; final refusal              |
| `operation_processing`           |       202 | `AnisApiError`               | Yes       | May be unknown; resume same id |
| `allowed_debt_consent_required`  |       402 | `AnisApiError`               | No        | No; final refusal              |
| `insufficient_balance`           |       409 | `InsufficientBalanceError`   | No        | No; final refusal              |
| `purchase_not_allowed`           | 403 / 409 | `AuthorizationError`         | No        | No; final refusal              |
| `owner_limit_exceeded`           |       409 | `LimitExceededError`         | No        | No; final refusal              |
| `daily_limit_exceeded`           |       429 | `LimitExceededError`         | No        | No; final refusal              |
| `rate_limited`                   |       429 | `RateLimitedError`           | Yes       | May be unknown; resume same id |
| `wallet_disabled`                |       409 | `AuthorizationError`         | No        | No; final refusal              |
| `wallet_expired`                 |       409 | `AuthorizationError`         | No        | No; final refusal              |
| `business_subscription_required` |       409 | `AuthorizationError`         | No        | No; final refusal              |
| `account_inactive`               |       403 | `AuthorizationError`         | No        | No; final refusal              |
| `currency_not_supported`         |       422 | `ValidationFailedError`      | No        | No; final refusal              |
| `card_unavailable`               |       409 | `OutOfStockError`            | No        | No; final refusal              |
| `quantity_unavailable`           |       409 | `OutOfStockError`            | No        | No; final refusal              |
| `price_changed`                  |       409 | `PriceChangedError`          | No        | No; final refusal              |
| `reveal_not_allowed`             |       409 | `AuthorizationError`         | No        | No; final refusal              |
| `invoice_reveal_limit_exceeded`  |       409 | `AnisApiError`               | No        | No; final refusal              |
| `invitation_invalid`             |       401 | `EnrollmentRefusedError`     | No        | No; final refusal              |
| `challenge_expired`              |       409 | `EnrollmentRefusedError`     | No        | No; final refusal              |
| `key_proof_invalid`              |       422 | `EnrollmentRefusedError`     | No        | No; final refusal              |
| `key_duplicate`                  |       409 | `EnrollmentRefusedError`     | No        | No; final refusal              |
| `dependency_unavailable`         |       503 | `DependencyUnavailableError` | Yes       | May be unknown; resume same id |
| `request_timeout`                |       504 | `DependencyUnavailableError` | Yes       | May be unknown; resume same id |
| `internal_error`                 |       500 | `DependencyUnavailableError` | Yes       | May be unknown; resume same id |

The typed subclasses group errors that partners commonly handle differently: `InsufficientBalanceError`, `PriceChangedError`, `OutOfStockError`, `LimitExceededError`, `RateLimitedError`, `IdempotencyConflictError`, `InvalidCredentialsError`, `ReplayDetectedError`, `AuthorizationError`, `ResourceNotFoundError`, `ValidationFailedError`, `DependencyUnavailableError`, and `EnrollmentRefusedError`. Other known and future codes use `AnisApiError`.

`isRetryable` reports the published error catalogue. For orders, always use the `OrderResult.kind` recovery rule as well: an error marked retryable does not mean a new operation id is safe.

`signature_expired` and `invalid_content_digest` remain documented in the published catalogue for compatibility but are not currently emitted by the API.
