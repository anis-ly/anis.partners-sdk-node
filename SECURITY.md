# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem. Email **support@anis.ly** with a description, the package version, and steps to reproduce it. You will receive an answer within five working days.

## Supported versions

Security fixes target 2.0.0. 1.x is deprecated — upgrade.

Version 2.0.0 requires the `anis-response-v2` profile and rejects compromised, retired-after-signing, and not-yet-valid response keys. See [response verification](docs/security.md#response-profile-and-response-key-lifecycle) for the exact rules and failure reasons.

## Your private key

The SDK does not send, store, or log your private key. It asks your `RequestSigner` for signatures. Keep the key in storage controlled by your organization; see [key custody](docs/security.md).
