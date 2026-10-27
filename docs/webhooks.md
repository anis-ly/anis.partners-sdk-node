# Webhooks

Anis sends a signed notification to your endpoint when a meter charge or a direct recharge reaches a milestone. Each notification carries the current state of the operation, so you can act on it without another call, but only after you have verified it.

## Set the endpoint

```ts
import { AnisPartnersClient, PemP256Signer } from '@anis-ly/partners';

const setting = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
};
const signer = (await PemP256Signer.fromPemFile('/secure/partner-key.pem')).forKey(setting('SAMPLE_KEY_ID'));
const client = AnisPartnersClient.create({ options: { authority: setting('ANIS_PARTNERS_AUTHORITY') }, signer });

const endpoint = await client.webhookEndpoint.set({ url: 'https://pos.example.ly/hooks/anis' });
console.log(endpoint.status, endpoint.generation);
```

The URL must use HTTPS on port 443 with a host name that contains a dot (`https://hooks.example.com` is accepted, `https://hooks` is refused with `webhook_endpoint_invalid`); an IP address is not a host name. `status` moves from `pendingVerification` to `verified` once your endpoint answers Anis's verification challenge, or is `disabled` when Anis staff stopped deliveries. After the endpoint is verified, `webhookEndpoint.test()` queues a test notification and `webhookEvents.getWebhookEvents()` shows delivery state. `webhookEvents.redeliver(eventId)` asks Anis to send the same notification again.

Anis calls your endpoint from one fixed address per deployment. If your firewall only accepts known sources, allow the
address listed in [Where webhooks come from](https://developers.anis.ly/docs/webhooks#where-webhooks-come-from); the signature, not the address, proves a request came from Anis.

## Verify before you read

Capture the raw request bytes before any JSON middleware touches them: the signature covers the exact body. Build one `PartnerWebhookVerifier` from your own configured URL and application id, never from the request.

```ts
import { HttpSigningKeySource, PartnerWebhookVerifier } from '@anis-ly/partners';
import type { VerifiableWebhook } from '@anis-ly/partners';

const configuredUrl = 'https://pos.example.ly/hooks/anis';
const applicationId = '9b2d1241-413e-4ae8-ae32-b15c58dbe101';
const authority = process.env.ANIS_PARTNERS_AUTHORITY ?? '';
const verifier = new PartnerWebhookVerifier(new HttpSigningKeySource({ authority }), { configuredUrl, applicationId });

export async function receive(request: VerifiableWebhook) {
  const event = await verifier.verifyAndParse(request);
  if (event.type === 'unknown') return event.rawType;
  return event.data.status;
}
```

`verify` checks the signature only; `verifyAndParse` also checks that the body's event id and application match the signed headers and returns the typed event. A failed check throws `UnverifiableWebhookError` whose `failure` is one of a closed list of reasons, and nothing from the body is returned. Reply with a non-success status for a failure and do not process the body.

Rules the verifier enforces:

- The signature lives five minutes from its creation time and the clock may differ by at most five minutes.
- The signed target must equal your configured URL exactly, including any query, and the signed application id must equal yours.
- The signing key must be published with purpose `webhook` and status `active` or `next`. Retired and compromised keys are refused whatever the signing date.

A `node:http` handler that requires your application’s durable inbox is in `samples/receiver/handler.ts` in the repository.

## Read the event

Known events (`meterCharge.succeeded`, `meterCharge.failed`, `directRecharge.paid`, `.paymentFailed`, `.suspended`, `.completed`, `.rejected`, `.partiallyRefunded`) carry the operation as it is at delivery time, which can be later than the event name suggests. For example, a `directRecharge.suspended` event can arrive with a status of `inProgress` after the recipient was corrected. Act on `data.status`, not on the event name. Future event types and the control events are accepted after verification with `type: 'unknown'` and the original `rawType`; they are never reported as a finished payment.

## Answer the verification challenge

When you set or change an endpoint, Anis sends a signed `webhook_endpoint.verification` event whose data has a `challenge` and a `generation`. Verify it first. Then answer with a 2xx status and exactly the JSON `{"challenge":"<same value>"}` within 10 seconds. Never answer a challenge from a request that failed verification. Do not log the challenge.

## Deduplicate on the event id

Anis may deliver the same event more than once; `id` stays the same while the attempt number changes. After verification, call the sample's `inbox.processOnce(event)`. Implement it with a unique event-id constraint in the same database transaction as your business changes or durable job/outbox insertion:

1. Begin a transaction and insert the event id into the inbox under a unique constraint.
2. On an already committed duplicate, finish without repeating business changes. A concurrent insert must wait for the first transaction to commit or roll back.
3. Apply business changes or insert a durable work item in that transaction, then commit. On failure roll back both the inbox admission and the changes.
4. Resolve `processOnce` only after commit. The handler acknowledges with 204 afterward; failures return 500 so delivery can retry.

Use an outbox for external side effects that cannot share the transaction. Separate “already handled” and “mark handled” calls, or an in-memory set, cannot guarantee this behavior across concurrent deliveries or restarts. The sample deliberately requires your durable adapter; the SDK stores no deduplication state.

The handler reconstructs the actual target from the configured external HTTPS origin and `request.url` (raw path and query), ignoring Host/forwarding headers. Configure your proxy to preserve that path and query; rewritten requests must be rejected rather than substituting the configured URL.
