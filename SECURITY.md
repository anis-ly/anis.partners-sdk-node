# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem. Email **support@anis.ly** with a description, the package version, and steps to reproduce it. You will receive an answer within five working days.

## Supported versions

Security fixes are made to the latest released version.

## Your private key

The SDK does not send, store, or log your private key. It asks your `RequestSigner` for signatures. Keep the key in storage controlled by your organization; see [key custody](docs/security.md).
