# Anis Partner SDK for Node.js

The `@anis-ly/partners` package calls the Anis Partner API with signed requests, verifies every signed answer before parsing it, and returns typed models and order outcomes. It targets Node.js 22 and later.

> **Disclaimer.** This SDK is an optional helper provided free of charge under the MIT License, "as is", without
> warranty of any kind. Anis (Aniscom for Technical Services) accepts no responsibility or liability for its use or for
> any loss arising from it. You remain responsible for your own integration — recording orders before you send them,
> recovery, key custody and testing. The source code is public: read it to understand exactly what it does before you
> rely on it. You do not need an SDK — you can integrate directly with the Anis Partner API using the documentation at
> https://developers.anis.ly.

```bash
npm install @anis-ly/partners@2.2.0
```

Version 2.2.0 uses the `anis-response-v2` verification profile. 1.x is deprecated — upgrade.

The response signing-key document is cached for at most 5 minutes (default and maximum 300 seconds), and unknown key ids trigger at most one re-fetch every 30 seconds per client (key source instance). Anis publishes retired keys for 90 days after retirement and keeps compromised key ids in `revoked[]` for 90 days. See [security and key custody](docs/security.md) for the verification rules.

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
const catalogueCard = await client.catalogue.getCard(walletId, card.id);
console.log(catalogueCard.category?.name, catalogueCard.logo);
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
if (result.kind === 'completed') {
  if (result.credentials.length > 0)
    await writeFile('credentials.json', JSON.stringify(result.credentials), { mode: 0o600 });
  if (result.codesWithheld) console.log('Completed; Anis withheld the credentials.');
  else console.log('Completed; credentials saved.');
} else if (result.kind === 'processing' || result.kind === 'unknown')
  console.log('Resume', result.operationId, result.suggestedDelayMs);
else if (result.kind === 'replayed') console.log('Previously completed', result.order.invoiceId);
else console.log('Not placed', result.refusal.code);
```

CommonJS users can load the package with: `const { AnisPartnersClient } = require('@anis-ly/partners');`

- [Getting started](https://github.com/anis-ly/anis.partners-sdk-node/blob/main/docs/getting-started.md) — enrollment, configuration, first call, and serverless hosts
- [Orders and recovery](https://github.com/anis-ly/anis.partners-sdk-node/blob/main/docs/orders-and-recovery.md) — safe purchase retries and the five outcomes
- [Routes and permissions](https://github.com/anis-ly/anis.partners-sdk-node/blob/main/docs/routes-and-permissions.md) — all routes, permissions, profiles, and bodies
- [Errors](https://github.com/anis-ly/anis.partners-sdk-node/blob/main/docs/errors.md) — stable error codes and typed errors
- [Webhooks](https://github.com/anis-ly/anis.partners-sdk-node/blob/main/docs/webhooks.md) — verify notifications, answer the verification challenge, and avoid duplicates
- [Security and key custody](https://github.com/anis-ly/anis.partners-sdk-node/blob/main/docs/security.md)
- [Observability](https://github.com/anis-ly/anis.partners-sdk-node/blob/main/docs/observability.md)
- [Runnable console sample](https://github.com/anis-ly/anis.partners-sdk-node/blob/main/samples/console/README.md)

## Refusals built into the design

- The caller supplies and persists each order id. A timeout is unresolved, so recovery repeats the same id and body; it never silently creates a second purchase.
- `OrderResult` is a discriminated union. Credentials appear only on `completed`; a `replayed` result is state only.
- Credential objects and completed order results contain secret fields. `JSON.stringify` includes voucher and serial values; do not log or serialize them casually. Persist released credentials in a secret store with owner-only permissions.
- A refusal that may follow an earlier attempt is `unknown`; a final business refusal is `notPlaced`. For meter charges and direct recharges an `idempotency_conflict` is `unknown`: read the operation by its id before any new attempt, and note that `get` can throw the recorded refusal (`AnisApiError` with `isReplayed`), which means the attempt was not placed.
- Every request is signed. Every answer that moves money, delivers card codes or establishes a key — access stops, orders, order reads, card and invoice reveals, enrollment, and the signature self-test — is verified before the SDK returns or parses it, success and refusal alike; one that arrives unsigned or fails verification is discarded, and an unverifiable order has an unknown outcome. Profile, wallet, catalogue and owned-card reads are information answers that Anis does not sign; the SDK reads them as received over HTTPS. Which routes are signed is fixed per route in the SDK, never guessed from the answer.
- Logging and telemetry are opt-in listeners and omit signatures, signature bases, nonces, enrollment tokens, and credentials.

## What is covered

The published API routes are grouped under `access`, `profile`, `wallets`, `catalogue`, `orders`, `ownedCards`, `diagnostics`, `meterCharges`, `directRechargeProducts`, `directRecharges`, `webhookEndpoint` and `webhookEvents`, with `AnisEnrollmentClient` for enrollment. Lists can be consumed page by page with `listPage({ cursor, signal })` or walked as an `AsyncIterable` with `list()`.

## Meter charges, direct recharge and notifications

Version 2.2.0 adds three products on top of card orders. Each money-moving call follows the same rule as orders: you create and persist the operation id and the exact request before sending, and an interrupted call is recovered by resuming with the same id and request.

### Charge a meter

`client.meterCharges` lists the packages priced for a wallet, charges a meter, and reads the receipt. A successful charge carries the receipt with every token in the order Anis returned it. A failed charge says whether the money was refunded, not charged, or is still waiting to be refunded.

```ts
import { AnisPartnersClient, PemP256Signer } from '@anis-ly/partners';
import { writeFile } from 'node:fs/promises';

const setting = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
};
const signer = (await PemP256Signer.fromPemFile('/secure/partner-key.pem')).forKey(setting('SAMPLE_KEY_ID'));
const client = AnisPartnersClient.create({ options: { authority: setting('ANIS_PARTNERS_AUTHORITY') }, signer });
const walletId = setting('WALLET_ID');

let selected;
for await (const candidate of client.meterCharges.getMeterPackages(walletId)) {
  selected = candidate;
  break;
}
if (!selected) throw new Error('No package is offered to this wallet.');
const operationId = crypto.randomUUID();
const request = {
  packageId: selected.id,
  meterNumber: '0268000710262',
  expectedTotal: selected.unitPrice,
};
await writeFile('meter-intent.json', JSON.stringify({ operationId, walletId, request }), { flag: 'wx', mode: 0o600 });
const result = await client.meterCharges.create(walletId, operationId, request);
if (result.kind === 'final') console.log(result.meterCharge.status, result.meterCharge.receipt?.receiptNumber);
else if (result.kind === 'processing' || result.kind === 'unknown')
  console.log('Resume', result.operationId, result.suggestedDelayMs);
else console.log('Not placed', result.refusal.code);
```

The meter number is a string so leading zeros are kept. Tokens and credited amounts are secrets and exact decimal strings; do not log them. `client.meterCharges.getMeterCharges(walletId, options)` walks a wallet's charge history (31 days at a time) without receipts.

### Direct recharge

`client.directRechargeProducts` lists products, their recipient fields, locations and a quote. `client.directRecharges` places the direct recharge, recovers it, reads it and, while Anis has paused it for bad recipient data (`suspendedDataError`), corrects the recipient.

```ts
import { open } from 'node:fs/promises';
import { AnisPartnersClient, PemP256Signer } from '@anis-ly/partners';

const setting = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
};
const signer = (await PemP256Signer.fromPemFile('/secure/partner-key.pem')).forKey(setting('SAMPLE_KEY_ID'));
const client = AnisPartnersClient.create({ options: { authority: setting('ANIS_PARTNERS_AUTHORITY') }, signer });
const [walletId, productId] = [setting('WALLET_ID'), setting('PRODUCT_ID')];

const product = await client.directRechargeProducts.get(walletId, productId);
console.log(product.recipientFields.map((field) => field.key));
const quote = await client.directRechargeProducts.quote(walletId, productId, '1500.000', 'fx');
const operationId = crypto.randomUUID();
const request = {
  productId,
  payoutAmount: '1500.000',
  expectedTotal: quote.total,
  recipient: [{ key: 'recipient_number', value: setting('RECIPIENT_NUMBER') }],
};
// Exclusive creation prevents an accidental rerun from replacing an unresolved purchase.
const intentFile = await open('recharge-intent.json', 'wx', 0o600);
try {
  await intentFile.writeFile(JSON.stringify({ operationId, walletId, request }));
  await intentFile.sync();
} finally {
  await intentFile.close();
}
const result = await client.directRecharges.create(walletId, operationId, request);
if (result.kind === 'processing' || result.kind === 'unknown') console.log('Resume', result.operationId);
```

After a restart, restore the saved intent and reconstruct its Money value before resuming. Wait the previous result's `suggestedDelayMs` when available. Keep the file until you have recorded a final outcome; an existing file means recover it rather than create another purchase.

```ts
import { readFile } from 'node:fs/promises';
import { AnisPartnersClient, Money, PemP256Signer } from '@anis-ly/partners';

const authority = process.env.ANIS_PARTNERS_AUTHORITY;
const keyId = process.env.SAMPLE_KEY_ID;
if (!authority || !keyId) throw new Error('Set ANIS_PARTNERS_AUTHORITY and SAMPLE_KEY_ID.');
const signer = (await PemP256Signer.fromPemFile('/secure/partner-key.pem')).forKey(keyId);
const client = AnisPartnersClient.create({ options: { authority }, signer });
const saved = JSON.parse(await readFile('recharge-intent.json', 'utf8')) as {
  operationId: string;
  walletId: string;
  request: {
    productId: string;
    payoutAmount: string;
    expectedTotal: { amount: string; currency: string };
    recipient: { key: string; value: string }[];
  };
};
const resumed = await client.directRecharges.resume(saved.walletId, saved.operationId, {
  ...saved.request,
  expectedTotal: Money.of(saved.request.expectedTotal.amount, saved.request.expectedTotal.currency),
});
console.log(resumed.kind);
```

A recipient correction is a signed change: it uses the existing operation id and is never replayed automatically. `client.directRecharges.updateRecipient(operationId, { recipient })` returns a `DirectRechargeProcessing` (`{ kind: 'processing', operationId, suggestedDelayMs, location, accepted }`), the same type a 202 create answers, with the signed acknowledgement in `accepted` and `location` set. `suggestedDelayMs` comes from Retry-After (default 5000). The signed HTTP 202 body contains only `operationId`, `operationType: 'directRecharge'` and `status: 'processing'`; `location` is the verified Location header pointing to that operation's read on the configured authority. No direct recharge body is returned. Read with `client.directRecharges.get(result.operationId)` or wait for a `directRecharge.*` webhook to observe the correction. If the change fails in transit, read the operation before deciding to send it again.

### Notifications

`client.webhookEndpoint` sets the URL Anis delivers to, reads its state, and queues a test notification. `client.webhookEvents` lists deliveries and asks Anis to deliver one again. Your receiver verifies each delivery with `PartnerWebhookVerifier` before it reads the contents; see [webhooks](docs/webhooks.md).

## How it is proven

The tests include the checked-in request, response, enrollment proof, and safety-code vectors; in-memory client and transport tests; and contract drift checks against the checked-in route, response-signing and error contracts. `npm run check` runs formatting, strict type checks, lint, tests, and a package build.

The 2.0.0 response conformance vectors are regenerated alongside the gateway contract.

## Supported Node versions

Node.js 22 or later with ESM or CommonJS. Error code types are generated from `contracts/error-catalogue.json`:

```bash
npm run generate:errors
```

## License

[MIT](LICENSE) © 2026 Aniscom for Technical Services (Anis).

## Access and card models

Use `client.access.suspendApplication(reason)` to suspend this application and `client.access.revokeKey(keyId, reason)` to revoke one of its keys. These signed stop calls require a trimmed reason of 1–500 characters and no scope. Resume requires Anis staff; revocation is irreversible.

`client.ownedCards.list()`, `get()`, `reveal()`, and `revealInvoice()` use `/owned-cards` paths. A masked card has `soldCardId` and `operationId`; its `card: CardSummary` contains the name, face value, logo, subcategory, and category. Reveals and order `soldCards[]` share the full `RevealedCredential` shape. Wallet currency is `wallet.balance.currency`. Money amounts on the wire are strings with exactly three decimal places and uppercase three-letter currency codes. A wallet balance is negative (for example `-150.000`) while the wallet uses allowed debt; prices and totals are never negative. Catalogue quantity bounds are 1 and the platform limit of 100.

Catalogue subcategories expose `categoryType` as `local`, `international`, or `unknown`. A catalogue card's optional `category` includes its `type` with the same values; absent or unrecognized values are `unknown`.
