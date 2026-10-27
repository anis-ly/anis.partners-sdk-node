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

A spending-cap refusal (`spending_limit_exceeded`, HTTP 429, `LimitExceededError`) is `notPlaced`: the order would have taken the application or wallet past its spending cap for the current window, so nothing was bought or charged. `retryAfter` is the number of seconds until the window ends (windows follow UTC). After it, place a new order with a new id; never resume the refused one.

On `resume`, a replay-marked final refusal can be `notPlaced`; a fresh refusal that does not prove the earlier attempt stayed unsent remains `unknown`. The five temporary door refusals (`invalid_credentials`, `signature_expired`, `insufficient_scope`, `wallet_not_granted`, and `malformed_signed_request`) suggest waiting 60 seconds before resuming. Store any credentials from a first completed response immediately, before logging, formatting, or other work that can throw. A completed response with withheld codes is still a purchase: never order again to get the codes; contact support@anis.ly with the operation id.

A `processing` result whose order status is `recoveryExhausted` may still complete. Recovery exhausted does not mean failed. Continue to resume the same operation id, allowing minutes between attempts, and contact support@anis.ly with the id.

An order call rethrows caller cancellation, while telemetry records the result as unknown. A timeout, connection failure, or discarded response returns `unknown`. Both require recovery with the same id.

## Meter charges and direct recharges

`client.meterCharges` and `client.directRecharges` recover exactly like orders. Persist the operation id and the exact request, send `create`, and when the outcome is `processing` or `unknown` call `resume` with the same id and request after `suggestedDelayMs`. The result kinds are `processing`, `final`, `notPlaced` and `unknown`:

| `kind`       | Meaning                                                                                                    | Safe next step                                                          |
| ------------ | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `processing` | Anis accepted the operation, or its current state is not final (for example a meter refund still pending). | Wait, then resume the same id and request.                              |
| `final`      | The operation reached a closed state, including a failed meter charge with its refund.                     | Read the receipt or refund and stop resuming.                           |
| `notPlaced`  | A verified final refusal closed this attempt.                                                              | Correct the cause and use a new id for a new attempt.                   |
| `unknown`    | The answer was lost, unreadable or unverifiable, or a refusal on resume did not prove the attempt unsent.  | Resume the same id and request. Never start a new id for the same need. |

A failed meter charge whose refund is still `pending` is not final: money was taken and the refund is on its way. `final` arrives once the refund is `refunded` or `notCharged`; until then the result is `processing` and carries the full read in `meterCharge`, so read again or wait for the `meterCharge.failed` notification.

An `idempotency_conflict` on `create` or `resume` is `unknown`, never `notPlaced`: the id may already have been accepted and charged. Read the operation by its id (`meterCharges.get` or `directRecharges.get`) before any new attempt. A foreign id answers not found there, and a closed conflict answers the recorded refusal.

`get` itself can throw. When the operation was refused at creation, the read answers the recorded refusal (HTTP 409 or 422 with `Idempotency-Replayed: true`) instead of a 202: the SDK verifies the signature and raises the typed `AnisApiError` with its `code` and `isReplayed` set to `true`. That is the definitive answer for that id, so treat it as `notPlaced` and use a new id for a new attempt.

A processing acknowledgement carries only the operation id, the operation type and the status `processing`. The full read (`get`) is separate and carries the totals, times and receipt. An unrecognized status is never treated as final.

Recipient corrections (`directRecharges.updateRecipient`), endpoint changes (`webhookEndpoint.set`, `webhookEndpoint.test`) and redelivery (`webhookEvents.redeliver`) are signed changes without an idempotency key. They are not purchases and the SDK never replays them. If one fails in transit, read the direct recharge, endpoint or delivery list first, then decide whether to send it again.

`directRecharges.updateRecipient` accepts only a signed HTTP 202 and returns `DirectRechargeProcessing` (`{ kind: 'processing', operationId, suggestedDelayMs, location, accepted }`), the same type a 202 create answers. The signed acknowledgement is `accepted`, and `suggestedDelayMs` comes from Retry-After (default 5000). The signed body remains exactly the three-member `DirectRechargeAccepted` body (`operationId`, `operationType: 'directRecharge'`, `status: 'processing'`). `location` comes from the signed Location header, separately from that body. It must be the matching `/v1/direct-recharges/{operationId}` path or its absolute URL on the configured authority, without query, fragment or credentials. Missing/invalid locations, extra body members and HTTP 200 direct recharge bodies are discarded.

A processing acknowledgement confirms acceptance, not the corrected recipient state. The SDK does not follow Location or repeat PATCH automatically. For a returned `result`, read `directRecharges.get(result.operationId)` or wait for a `directRecharge.*` webhook before deciding whether another correction is needed.
