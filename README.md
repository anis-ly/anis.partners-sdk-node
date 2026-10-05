# Anis Partner SDK for Node.js

The `@anis-ly/partners` package calls the Anis Partner API with signed requests, verifies every response before parsing it, and returns typed models and order outcomes. It targets Node.js 22 and later and is at parity with the .NET SDK `Anis.Partners` 1.3.0.

```bash
npm install @anis-ly/partners
```

## Quick start

```ts
import { writeFile } from 'node:fs/promises';
import { AnisPartnersClient, PemP256Signer } from '@anis-ly/partners';
function setting(name: string): string {
  return process.env[name] ?? missing(name);
}
function missing(name: string): never {
  throw new Error(`Set ${name}.`);
}
const first = async <T>(items: AsyncIterable<T>) => {
  for await (const item of items) return item;
};
const signer = (await PemP256Signer.fromPemFile('/secure/partner-key.pem')).forKey(setting('SAMPLE_KEY_ID'));
const client = AnisPartnersClient.create({ options: { authority: setting('ANIS_PARTNERS_AUTHORITY') }, signer });
const profile = await client.profile.get();
console.log(profile.application?.scopes);
const [walletId, subcategoryId] = [setting('WALLET_ID'), setting('SUBCATEGORY_ID')];
const card = await first(client.catalogue.listCards(walletId, subcategoryId));
if (!card?.unitPrice) throw new Error('No price is available for this wallet.');
const operationId = crypto.randomUUID();
const quantity = 1;
const request = {
  cardId: card.id,
  quantity,
  expectedUnitPrice: card.unitPrice,
  expectedTotal: card.unitPrice.multiply(quantity),
};
await writeFile('order-intent.json', JSON.stringify({ operationId, walletId, request }), { flag: 'wx', mode: 0o600 });
const result = await client.orders.create(walletId, operationId, request);
if (result.kind === 'completed')
  await writeFile('credentials.json', JSON.stringify(result.credentials), { mode: 0o600 });
else if (result.kind === 'processing' || result.kind === 'unknown')
  console.log('Resume', result.operationId, result.suggestedDelayMs);
else if (result.kind === 'replayed') console.log('Previously completed', result.order.invoiceId);
else console.log('Not placed', result.refusal.code);
```

CommonJS users can load the package with: `const { AnisPartnersClient } = require('@anis-ly/partners');`

- [Getting started](https://github.com/anis-ly/anis.partners-sdk-node/blob/main/docs/getting-started.md) — enrollment, configuration, first call, and serverless hosts
- [Orders and recovery](https://github.com/anis-ly/anis.partners-sdk-node/blob/main/docs/orders-and-recovery.md) — safe purchase retries and the five outcomes
- [Routes and permissions](https://github.com/anis-ly/anis.partners-sdk-node/blob/main/docs/routes-and-permissions.md) — all routes, permissions, profiles, and bodies
- [Errors](https://github.com/anis-ly/anis.partners-sdk-node/blob/main/docs/errors.md) — stable error codes and typed errors
- [Security and key custody](https://github.com/anis-ly/anis.partners-sdk-node/blob/main/docs/security.md)
- [Observability](https://github.com/anis-ly/anis.partners-sdk-node/blob/main/docs/observability.md)
- [Runnable console sample](https://github.com/anis-ly/anis.partners-sdk-node/blob/main/samples/console/README.md)

## Refusals built into the design

- The caller supplies and persists each order id. A timeout is unresolved, so recovery repeats the same id and body; it never silently creates a second purchase.
- `OrderResult` is a discriminated union. Credentials appear only on `completed`; a `replayed` result is state only.
- A refusal that may follow an earlier attempt is `unknown`; a final business refusal is `notPlaced`.
- Every response is verified before the SDK returns or parses it. An unverifiable read is discarded, and an unverifiable order has an unknown outcome.
- Logging and telemetry are opt-in listeners and omit signatures, signature bases, nonces, enrollment tokens, and credentials.

## What is covered

All 19 published API routes are grouped under `profile`, `wallets`, `catalogue`, `orders`, `ownedCards`, and `diagnostics`, with `AnisEnrollmentClient` for enrollment. Lists can be consumed page by page with `listPage({ cursor, signal })` or walked as an `AsyncIterable` with `list()`.

## How it is proven

The tests include the published request, response, enrollment, and safety-code vectors; twins of the .NET vector suites; in-memory client and transport tests; and contract drift checks against the checked-in route and error contracts. `npm run check` runs formatting, strict type checks, lint, tests, and a package build.

**Proven live: not yet.**

## Supported Node versions

Node.js 22 or later with ESM. Error code types are generated from `contracts/error-catalogue.json`:

```bash
npm run generate:errors
```

## License

[MIT](LICENSE) © 2026 Aniscom for Technical Services (Anis).
