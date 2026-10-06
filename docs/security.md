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

Use an HTTPS authority for every network host. The response-signing-key document is unsigned, so plain HTTP would let someone on the network replace it, forge answers, and read card codes in transit. HTTP is accepted only for `localhost`, `127.0.0.1`, and `::1` during local testing.

## Response verification is mandatory

The SDK verifies the signed response and its body digest before parsing any answer. Do not pass an unverified response to business logic or add an option that bypasses verification. Reads that fail verification throw `UnverifiableResponseError`; orders return `unknown` because the purchase may have completed.

## Enrollment and rotation

Submit only a public JWK. Protect the private key before submission. After proving possession, check that the proof state is `accepted`, then give the safety code to Anis staff over the phone so they can confirm the key. Check `EnrollmentStatus.keyExpiresAt` and request a replacement well before expiry. For partner request-key rotation, Anis staff start the process and the partner enrolls a replacement key; both request keys are accepted during the overlap, while a revoked key is refused as `invalid_credentials`. Separately, Anis publishes its response-signing keys in the signing-key document. When a signed response names an unknown response-key id, the SDK refreshes that document once before rejecting the response. These key rotations serve different directions: never select either key with an environment switch; follow the issued key id and Anis's rotation process.

Read the safety code from your own enrollment software and repeat it to Anis staff over the phone; do not accept a code sent to you by email or chat. An expired key cannot authenticate requests; enrol a replacement before `keyExpiresAt` and contact support@anis.ly if the key has expired. The SDK checks the response body digest before checking its signature so altered content is reported as a digest mismatch before any parsed answer can be used.

## Logs and clocks

Never log credentials, signing keys, enrollment tokens, signatures, signature bases, or nonces. Keep the host clock synchronized: stale or future timestamps can make requests fail verification. The SDK's logger fields and OpenTelemetry tags omit secret values by design.
