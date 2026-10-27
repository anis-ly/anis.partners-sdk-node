# Security and key custody

## Keep the private key with your organization

`PemP256Signer` is convenient when the host protects a PKCS#8 PEM file. For a KMS or HSM, implement `RequestSigner` so private material never enters the SDK process:

```ts
import type { RequestSigner } from '@anis-ly/partners';

interface PartnerHsm {
  signP256Sha256(data: Uint8Array): Promise<Uint8Array>;
}

class HsmSigner implements RequestSigner {
  constructor(
    readonly keyId: string,
    private readonly hsm: PartnerHsm,
  ) {}
  async sign(data: Uint8Array): Promise<Uint8Array> {
    return this.hsm.signP256Sha256(data);
  }
}
```

The returned bytes must be a 64-byte ECDSA P-256 signature in IEEE P1363 form. Some crypto libraries return ASN.1 DER, which has a variable length (often 70–72 bytes). The SDK refuses that form; configure the KMS/HSM operation to return P1363 bytes instead of transforming signatures in application code.

The browser must never hold the private key. Browser code can be inspected or modified by its user, so signing belongs on a trusted server.

## Protect the authority connection

Use an HTTPS authority for every network host. The response-signing-key document and the information reads are unsigned, so plain HTTP would let someone on the network replace the key document, forge answers, alter balances and catalogue prices, and read card codes in transit. HTTP is accepted only for `localhost`, `127.0.0.1`, and `::1` during local testing.

## Response verification is mandatory on signed routes

Anis signs every answer that moves money, delivers card codes or establishes a key, and the SDK verifies the signature and body digest of each of those answers before parsing it. The signed routes are application suspension, key revocation, order creation and recovery, order reads, card and invoice reveals, the four enrollment routes, and the signature self-test. On these routes the success and every refusal are signed: an answer with no signature fails as `signature_missing`, and nothing in it — not even its error code — is used. Reads that fail verification throw `UnverifiableResponseError`; orders return `unknown` because the purchase may have completed. There is no option that bypasses this; do not pass an unverified answer from these routes to business logic.

Information reads — the profile, wallets, the catalogue reads, and the owned-card list and masked-card read — are answered unsigned (they still carry `Content-Digest` and `X-Request-Id`). The SDK reads those answers, success or refusal, as received over the HTTPS connection, and it does not fetch the signing-key document for them; if such an answer carries a signature anyway, the SDK ignores it. Which routes are signed is fixed per route in the SDK's route table and checked against the published contract; it is never inferred from whether an answer happens to carry a signature, so a stripped signature on a signed route is always refused. HTTPS is what protects information reads, which is one more reason the authority must use HTTPS.

## Notifications use a separate key and profile

Anis signs notifications with a webhook-purpose key under the `anis-partner-webhook-v1` profile, which is separate from response signing. `PartnerWebhookVerifier` takes the receiver's own configured URL and application id; it never trusts the request's `Host` or forwarded headers. It accepts only keys that the published key document marks `purpose: "webhook"` with status `active` or `next`, and refuses retired and compromised keys. See [webhooks](webhooks.md).

## Enrollment and rotation

Submit only a public JWK. Protect the private key before submission. After proving possession, check that the proof state is `accepted`, then give the safety code to Anis staff over the phone so they can confirm the key. Check `EnrollmentStatus.keyExpiresAt` and request a replacement well before expiry. For partner request-key rotation, Anis staff start the process and the partner enrolls a replacement key; both request keys are accepted during the overlap, while a revoked key is refused as `invalid_credentials`. Separately, Anis publishes its response-signing keys in the signing-key document. When a signed response names an unknown response-key id, the SDK refreshes that document once before rejecting the response, and at most once every 30 seconds per client (key source instance). These key rotations serve different directions: never select either key with an environment switch; follow the issued key id and Anis's rotation process.

Read the safety code from your own enrollment software and repeat it to Anis staff over the phone; do not accept a code sent to you by email or chat. An expired key cannot authenticate requests; enrol a replacement before `keyExpiresAt` and contact support@anis.ly if the key has expired. The SDK checks the response body digest before checking its signature so altered content is reported as a digest mismatch before any parsed answer can be used.

## Logs and clocks

Never log credentials, meter tokens, recipient details, verification challenges, signing keys, enrollment tokens, signatures, signature bases, or nonces. Keep the host clock synchronized: stale or future timestamps can make requests, and signed answers, fail verification. The SDK's logger fields and OpenTelemetry tags omit secret values by design.

## Response profile and response key lifecycle

Signed answers require label `sig1`, algorithm `ecdsa-p256-sha256`, and `tag="anis-response-v2"` after `alg`. Missing or different tags fail as `profile_unexpected`. The SDK rebuilds the exact covered list: `"@status"`, `"content-digest"`, `"x-request-id"`, followed by `"signature-input";req` and `"signature";req` when the request is signed, then present `location`, `retry-after`, `idempotency-replayed`, and `cache-control` in that order. The request `Signature` value is bound raw, including its `sig1=:…:` wrapper. Enrollment answers have no request signature binding. A different list fails as `covered_components_mismatch`.

The cached key document contains `keys[]` with `status` (`active`, `next`, `retired`), `notBefore`, and `retiredAt` for retired keys, plus `revoked[]` entries with `kid` and `compromisedAt`. A revoked key fails as `key_compromised`, even if its signature predates compromise. A retired key fails as `key_retired` when signature `created` is later than `retiredAt`; any published key (`active`, `next` or `retired`) fails as `key_not_yet_valid` when `created` precedes its `notBefore`. Equality at either boundary is accepted. The normal 60-second response freshness window still applies.

The SDK keeps the key document for at most 5 minutes (`signingKeyCacheSeconds`, default and maximum 300 seconds). This is the SDK's own cache contribution to revocation propagation. The agreed end-to-end revocation bound is approximately 7 minutes: up to 60 seconds for the gateway's key-metadata refresh, 60 seconds of HTTP `max-age`, and 300 seconds of SDK caching. Anis keeps a retired key in the document for 90 days after it retires, and a compromised key id in `revoked[]` for 90 days, so a stored answer can still be checked during a dispute.

The standalone `HttpSigningKeySource` requires HTTPS, including in tests; HTTP loopback is refused because this unsigned document supplies the trusted keys. Use an injected fetch double for offline tests. It refuses redirects and compressed key documents.

API answers accept only keys marked `purpose: "answer"` or legacy keys without a purpose. A webhook-purpose key cannot verify an API answer. Webhook verification requires `purpose: "webhook"` explicitly and refuses answer keys and purpose-less keys; its active/next-only rule remains separate from API-answer retirement verification.
