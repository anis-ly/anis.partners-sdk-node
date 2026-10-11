# Changelog

Versions follow [Semantic Versioning](https://semver.org/).

## [2.0.0] - 2026-10-11

### Breaking changes

1.x is deprecated — upgrade.

- Require `tag="anis-response-v2"` and bind both raw request signature headers in every signed machine answer.
- Reject compromised response keys and signatures outside next/retired key signing intervals.
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
