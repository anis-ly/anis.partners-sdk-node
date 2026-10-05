# Orders and recovery

An order moves money. Persist the operation id and exact request before calling the API. The id becomes `Idempotency-Key`; Anis uses it to recognize the same purchase after a lost answer or process restart.

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

## The five outcomes

| `kind`       | Meaning                                                                                                   | Safe next step                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `completed`  | Purchase finished. This first completion answer may carry credentials; it can also report withheld codes. | Store credentials in your secret store immediately. Never buy again when codes are withheld.            |
| `processing` | Anis accepted the order but has not recorded a final result.                                              | Wait `suggestedDelayMs`, then resume the same id and exact request.                                     |
| `replayed`   | This id already has a terminal answer. Credentials are not repeated.                                      | Read stored credentials or use an authorized reveal.                                                    |
| `notPlaced`  | A final refusal closed the attempt; nothing was bought or charged.                                        | Correct the cause and use a new id for a new purchase.                                                  |
| `unknown`    | The answer was lost, discarded, or did not settle whether the order completed.                            | Resume the same id and exact request after `suggestedDelayMs`. Never make a new id for the same intent. |

`client.orders.get(operationId)` reads state only; it does not dispatch the order or return credentials. `client.orders.resume(walletId, operationId, request)` repeats the same signed POST. The SDK does not keep an order journal for you.

A `processing` result whose order status is `recoveryExhausted` may still complete. Continue to resume the same operation id, allowing minutes between attempts, and contact support@anis.ly with the id.

An order call rethrows caller cancellation, while telemetry records the result as unknown. A timeout, connection failure, or discarded response returns `unknown`. Both require recovery with the same id.
