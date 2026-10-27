# Changelog

Versions follow [Semantic Versioning](https://semver.org/).

## [2.2.0] - 2026-10-27

### Added

- Charge electricity meters and read receipts, tokens and refunds with safe recovery after an interrupted request.
- Quote Direct recharge, follow direct recharges and correct recipient details while a direct recharge is paused. Recipient corrections return `DirectRechargeProcessing`, the same type a 202 create answers, with the signed acknowledgement in `accepted` and a validated `location`; read the operation or wait for its webhook to observe the correction.
- Manage a webhook endpoint and request delivery again when a notification was missed.
- Verify notifications before reading their contents and keep recipient field errors available to the integration.

### Changed

- For meter charges and direct recharges, an `idempotency_conflict` on `create` or `resume` is now `unknown` instead of `notPlaced`: the id may already be accepted and charged. Read the operation by its id before any new attempt.
- Reading a meter charge or direct recharge by id can raise the recorded refusal (HTTP 409 or 422, `isReplayed` true) as a typed `AnisApiError`; this is documented.
- A failed meter charge whose refund is still pending stays `processing`; it becomes `final` when the refund is `refunded` or `notCharged`.
- `MeterFailure.message`, `MeterPackage.logo`, and the `name` of a recipient field or stored recipient value are optional, as in the published contract.
- Documentation states that a webhook endpoint host name must contain a dot (`webhook_endpoint_invalid` otherwise).
- Documentation and examples use the lowercase recipient keys (`recipient_number`, `recipient_name`) and the plain words direct recharge and electricity company.

### Security

- Response and webhook verification keep key purposes apart: an answer key never verifies a webhook and a webhook key never verifies an answer.

## [2.1.0] - 2026-10-18

### Added

- Catalogue subcategories expose `categoryType` as local, international, or unknown when absent or unrecognized.
- Catalogue card categories expose `type` as local, international, or unknown when absent or unrecognized; owned cards, reveals, and orders are unchanged.

## [2.0.1] - 2026-10-13

### Fixed

- A wallet whose balance is below zero — while it uses allowed debt — can be read again. In 2.0.0, listing or reading such a wallet failed with an error. Amounts in Anis's answers may carry a leading minus sign (`-150.000`); `-0.000` reads as zero. `Money.of()` accepts a negative amount too.
- Prices you send are unchanged: an order still refuses a unit price that is not greater than zero, before anything is sent.
- Documentation: the spending-cap refusal (`spending_limit_exceeded`) in Orders and recovery; the money rule in the README.

## [2.0.0] - 2026-10-13

### Breaking changes

1.x is deprecated — upgrade.

- Require `tag="anis-response-v2"` and bind both raw request signature headers in every signed machine answer.
- Reject compromised response keys (`key_compromised`), signatures created before any published key's `notBefore` (`key_not_yet_valid` for active, next and retired keys), and signatures created after a retired key's `retiredAt` (`key_retired`).
- The signing-key document is cached for 5 minutes by default and at most 5 minutes; `signingKeyCacheSeconds` above 300 is refused.
- An unknown response key id re-fetches the key document at most once per 30 seconds per client (key source instance), failed fetches included; inside that window it fails as `unknown_key` without a request.
- Documentation: retired keys stay published for 90 days after retirement.
- Recognise `spending_limit_exceeded` (HTTP 429): a spending-capped order is not placed and is reported as `LimitExceededError` with the `Retry-After` delay until the spending window ends.
- Use `/owned-cards` routes and `soldCardId` / `operationId` on masked cards. Share `CardSummary` across owned cards, reveals, and order credentials; include logo and category on catalogue cards and description on subcategory list entries.
- Wallet currency is available through `balance.currency`. Wire money is non-negative with exactly three decimal places and uppercase three-letter currency codes.
- Add `access.suspendApplication(reason)`, `access.revokeKey(keyId, reason)`, and `catalogue.getCard(walletId, cardId)`.

## [1.1.0] - 2026-10-07

Anis now signs only the answers that move money, deliver card codes or establish a key, and this release follows that contract.

- Signed routes are unchanged: order creation and recovery, order reads, card and invoice reveals, the four enrollment routes, and the signature self-test. Every answer on them, success and refusal, is verified before it is parsed, and one without a signature still fails as `signature_missing`.
- Information reads — profile, wallets, the four catalogue reads, the owned-card list and the masked-card read — are answered unsigned. The SDK now reads those answers, and maps their refusals to the same typed errors, as received over HTTPS. It no longer fetches the signing-key document for them, and it ignores a signature such an answer may still carry.
- Whether a route's answers are signed is declared per route (`signedResponse` in the route table) and checked against the published contract; it is never inferred from the answer. The transport also refuses a request whose path is not an instance of the route it names.
- Every request is still signed exactly as before; nothing changes in how a partner authenticates.
- Documentation states the rule in the README, security, routes-and-permissions, getting-started and observability pages.

## [1.0.0] - 2026-10-06

First Node.js release. The package provides all 19 Partner API routes, P-256 signed requests, verified responses, typed order recovery, key enrollment and safety-code support, generated error-code types, cursor paging, and OpenTelemetry instrumentation. It supports Node.js 22 and later with ESM and CommonJS entry points.
