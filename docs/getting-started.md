# Getting started

> **Disclaimer.** This SDK is an optional helper provided free of charge under the MIT License, "as is", without
> warranty of any kind. Anis (Aniscom for Technical Services) accepts no responsibility or liability for its use or for
> any loss arising from it. You remain responsible for your own integration — recording orders before you send them,
> recovery, key custody and testing. The source code is public: read it to understand exactly what it does before you
> rely on it. You do not need an SDK — you can integrate directly with the Anis Partner API using the documentation at
> https://developers.anis.ly.

## 1. Enroll a key

An Anis application needs an active P-256 signing key. Anis provides an invitation id and a single-use enrollment token. Generate the key pair and protect its private half before submitting the public half. The SDK verifies that the returned thumbprint matches the submitted key, proves possession, and gives you a safety code. Anis staff call your technical contact and ask them to read that code before confirming the key. The key signs API requests after its state becomes `active`.

The console sample's `enrol` command performs these steps and creates the private PEM file with owner-only permissions from the moment it is created. Confirm the proof state is `accepted`, then wait for Anis staff to confirm the safety code before sending API requests. You can also use the enrollment client directly:

```ts
import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AnisEnrollmentClient, PemP256Signer } from '@anis-ly/partners';

const setting = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
};
const keyPath = '/secure/enrollment-key.pem';
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
await mkdir(dirname(keyPath), { recursive: true });
const file = await open(keyPath, 'wx', 0o600);
await file.writeFile(privatePem, 'utf8');
await file.close();
await chmod(keyPath, 0o600);
const signer = await PemP256Signer.fromPem(privatePem);
const jwk = await signer.publicJwk();
const enrollment = AnisEnrollmentClient.create({
  authority: setting('ANIS_PARTNERS_AUTHORITY'),
  invitationId: setting('ENROLLMENT_INVITATION_ID'),
  enrollmentToken: setting('ENROLLMENT_TOKEN'),
});
const submitted = await enrollment.submitKey({
  publicJwk: jwk,
  notBefore: new Date(),
  expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
});
const proof = await enrollment.prove(submitted, signer);
if (proof.proofState !== 'accepted') throw new Error('The key proof was not accepted.');
console.log(submitted.keyId, submitted.safetyCode); // read the safety code to Anis staff by phone
console.log((await enrollment.getStatus()).state); // wait until active
```

The enrollment token is a secret. Do not put it in source control, command history, or logs. A failed proof is a normal answer with a `proofState`; check it before asking Anis to restart enrollment. If the challenge expires, contact Anis for a new invitation.

The enrollment state progresses through `pendingProof`, `pendingApproval`, and `active`; `unavailable` means the invitation or key cannot proceed. A proof challenge is valid for 30 minutes and permits five failed proof attempts. A failed proof is not itself an enrollment refusal. `invitation_invalid`, `challenge_expired`, `key_proof_invalid`, and `key_duplicate` are enrollment refusals; do not retry the same refused step. If the submit-key answer is lost or returns `key_duplicate`, read the enrolment status first; otherwise ask Anis staff to restart the enrolment. The `key_duplicate` refusal does not return existing enrollment details. The private half is saved first so a lost response never leaves you without the key needed to finish proof. `notBefore` and `expiresAt` define a validity interval, not a renewal schedule. Agree the network source addresses with Anis staff, and when asking for help provide the response request id.

## 2. Configure the client

```ts
import { AnisPartnersClient, PemP256Signer } from '@anis-ly/partners';

const setting = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
};
const signer = (await PemP256Signer.fromPemFile(setting('SAMPLE_KEY_FILE'))).forKey(setting('SAMPLE_KEY_ID'));
const client = AnisPartnersClient.create({
  options: {
    authority: setting('ANIS_PARTNERS_AUTHORITY'),
    signatureLifetimeSeconds: 60,
    acceptLanguage: 'en',
    signingKeyCacheSeconds: 600,
    timeoutMs: 30_000,
  },
  signer,
});
```

The signature lifetime is limited to 1–60 seconds. The API may accept a wider window, but the SDK verifies answers only within 60 seconds of its clock; longer request signatures could make a valid order answer too old to accept. Keep the host clock synchronized. Requests do not retry automatically: a host retry policy can repeat a reveal or obscure the one-time credentials from an order. Never configure the injected fetch to retry a request; it would reuse the same nonce. Call the matching SDK operation again to recover an order.

## 3. Make a first call

```ts
const profile = await client.profile.get();
console.log(profile.application?.scopes); // permissions effective for this call
```

Permissions are evaluated on each request. Read the profile when you need to understand current access instead of assuming a permission remains unchanged.

For each new order, generate a fresh UUID v4 with `crypto.randomUUID()`. Persist that id and the exact request before calling `orders.create`; reuse both only when recovering that purchase.

## When a signature will not verify

Use the side-effect-free signature check if your application has `diagnostics:use`:

```ts
import { AnisPartnersClient, PemP256Signer } from '@anis-ly/partners';

const setting = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
};
const signer = (await PemP256Signer.fromPemFile(setting('SAMPLE_KEY_FILE'))).forKey(setting('SAMPLE_KEY_ID'));
const client = AnisPartnersClient.create({ options: { authority: setting('ANIS_PARTNERS_AUTHORITY') }, signer });
const diagnostic = await client.diagnostics.checkSignature();
console.log(diagnostic.method, diagnostic.authority, diagnostic.path);
console.log(diagnostic.canonicalQuery, diagnostic.coveredComponents);
```

Compare the reported authority, path, query, and components with the request that failed. Check that a proxy did not rewrite the host, signed headers, or body. An `invalid_credentials` response can also mean the wrong key id, a key that is not active or has expired, or a host clock more than about 30 seconds fast or 60 seconds slow. `malformed_signed_request` points to a rewritten or incomplete signed request. `insufficient_scope` can mean missing permission or a source network that was not agreed with Anis.

## Serverless hosts

The SDK caches Anis's public response-signing-key document in process memory. In a short-lived or multi-instance host, supply `keyCache` so each instance can share the document and avoid an extra fetch. The cache stores only the public key document; it never stores your private signing key.

```ts
import { AnisPartnersClient, PemP256Signer } from '@anis-ly/partners';

const setting = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
};
const signer = (await PemP256Signer.fromPemFile(setting('SAMPLE_KEY_FILE'))).forKey(setting('SAMPLE_KEY_ID'));
const documents = new Map<string, { text: string; expiresAt: number }>();
const keyCache = {
  async get(key: string) {
    const entry = documents.get(key);
    if (entry === undefined || entry.expiresAt <= Date.now()) return undefined;
    return entry.text;
  },
  async set(key: string, value: string, ttlSeconds: number) {
    documents.set(key, { text: value, expiresAt: Date.now() + ttlSeconds * 1000 });
  },
};
const client = AnisPartnersClient.create({
  options: { authority: setting('ANIS_PARTNERS_AUTHORITY') },
  signer,
  keyCache,
});
```

Implement `get(key)` as `Promise<string | undefined>` and `set(key, value, ttlSeconds)` as `Promise<void>`. The in-memory map shows the adapter shape for one process; delegate those calls to a cache shared by serverless instances. Use the expiry supplied by the SDK. Treat that cache as part of your trust boundary: only your application should be able to write its signing-key entries. Someone who can replace the unsigned public-key document can make the SDK trust forged responses. Never place the private key in a browser: a browser cannot keep it secret from its user or from injected page code. Keep signing on a trusted server.
