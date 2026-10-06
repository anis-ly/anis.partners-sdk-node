# Orders and recovery

An order moves money. Persist the operation id and exact request before calling the API. The id becomes `Idempotency-Key`; Anis uses it to recognize the same purchase after a lost answer or process restart.

Create a fresh UUID v4 for every new purchase, then store it with the exact request before sending. Recovery is a signed POST through `resume`, never a GET loop. Do not wrap the SDK fetch function in a retry policy: it can resend the same nonce and trigger replay detection. Recover by calling `resume` with the same operation id and request.

## Use the wallet price

Read the card through `client.catalogue.listCards(walletId, subcategoryId)`. Send its `unitPrice`, not display-only business, personal, or special-offer prices. Use `Money.multiply()` to calculate the exact total; floating-point arithmetic can make the total differ from the amount Anis checks.

```ts
import { writeFile } from 'node:fs/promises';
import { AnisPartnersClient, PemP256Signer } from '@anis-ly/partners';
import type { CatalogueCard } from '@anis-ly/partners';
const setting = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
};
const signer = (await PemP256Signer.fromPemFile('/secure/partner-key.pem')).forKey(setting('SAMPLE_KEY_ID'));
const client = AnisPartnersClient.create({ options: { authority: setting('ANIS_PARTNERS_AUTHORITY') }, signer });
const walletId = setting('WALLET_ID');
const subcategoryId = setting('SUBCATEGORY_ID');
let card: CatalogueCard | undefined;
for await (const candidate of client.catalogue.listCards(walletId, subcategoryId)) {
  card = candidate;
  break;
}
if (!card?.unitPrice) throw new Error('No unit price is available for this wallet.');
const operationId = crypto.randomUUID();
const request = {
  cardId: card.id,
  quantity: 2,
  expectedUnitPrice: card.unitPrice,
  expectedTotal: card.unitPrice.multiply(2),
};
await writeFile('order-intent.json', JSON.stringify({ operationId, walletId, request }), { flag: 'wx', mode: 0o600 });
const result = await client.orders.create(walletId, operationId, request);
switch (result.kind) {
  case 'completed':
    // Store credentials before later work can fail or throw.
    await writeFile('credentials.json', JSON.stringify(result.credentials), { mode: 0o600 });
    console.log(result.codesWithheld ? 'Completed; codes were withheld.' : 'Completed; credentials saved.');
    break;
  case 'processing':
  case 'unknown':
    console.log('Resume the same operation later:', result.operationId, result.suggestedDelayMs);
    break;
  case 'replayed':
    console.log('Already delivered; use stored credentials or authorized reveal:', result.order.invoiceId);
    break;
  case 'notPlaced':
    console.log('Not placed:', result.refusal.code);
    break;
}
```

`Money` accepts decimal strings only and at most three fractional digits. `useAllowedDebt` defaults to false; set it only when the purchase is intended to use the owner's allowed debt balance.

The SDK does not generate or persist operation ids: create a fresh UUID v4 for each new purchase and keep it with the exact request. Invalid ids and local order values reject the Promise directly with `TypeError` or `RangeError` before anything is sent; they are not `OrderResult` values. A `RequestSigningError` also rejects before sending, but only after the inputs are valid, when signing or request construction fails. A verified order refusal is returned as a result. Set `externalReference` only to a short partner reference for reconciliation; never put credentials or personal data there. If Anis returns `allowed_debt_consent_required` (HTTP 402), enable `useAllowedDebt` only when the owner has explicitly authorized that purchase to use allowed debt.

## The five outcomes

| `kind`       | Meaning                                                                                                   | Safe next step                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `completed`  | Purchase finished. This first completion answer may carry credentials; it can also report withheld codes. | Store credentials in your secret store immediately. Never buy again when codes are withheld.            |
| `processing` | Anis accepted the order but has not recorded a final result.                                              | Wait `suggestedDelayMs`, then resume the same id and exact request.                                     |
| `replayed`   | This id already has a terminal answer. Credentials are not repeated.                                      | Read stored credentials or use an authorized reveal.                                                    |
| `notPlaced`  | A final refusal closed the attempt; nothing was bought or charged.                                        | Correct the cause and use a new id for a new purchase.                                                  |
| `unknown`    | The answer was lost, discarded, or did not settle whether the order completed.                            | Resume the same id and exact request after `suggestedDelayMs`. Never make a new id for the same intent. |

`client.orders.get(operationId)` reads state only; it does not dispatch the order or return credentials. `client.orders.resume(walletId, operationId, request)` repeats the same signed POST. The SDK does not keep an order journal for you.

On `resume`, a replay-marked final refusal can be `notPlaced`; a fresh refusal that does not prove the earlier attempt stayed unsent remains `unknown`. The five temporary door refusals (`invalid_credentials`, `signature_expired`, `insufficient_scope`, `wallet_not_granted`, and `malformed_signed_request`) suggest waiting 60 seconds before resuming. Store any credentials from a first completed response immediately, before logging, formatting, or other work that can throw. A completed response with withheld codes is still a purchase: never order again to get the codes; contact support@anis.ly with the operation id.

A `processing` result whose order status is `recoveryExhausted` may still complete. Recovery exhausted does not mean failed. Continue to resume the same operation id, allowing minutes between attempts, and contact support@anis.ly with the id.

An order call rethrows caller cancellation, while telemetry records the result as unknown. A timeout, connection failure, or discarded response returns `unknown`. Both require recovery with the same id.
