# Console sample

The sample demonstrates enrollment, reads across the API, order creation and recovery, reveals, diagnostics, and the signing-key document.

```bash
npm run build && node --experimental-strip-types samples/console/main.ts help
```

The sample requires Node 22.6 or later because it runs TypeScript ESM directly. Use `--experimental-strip-types` on Node 22.6 through Node 22.17 and Node 23; Node 22.18 and later, including Node 24+, strip types without the flag.

## Settings

The sample reads `samples/console/settings.json` and then applies environment overrides:

| Environment variable      | Purpose                              |
| ------------------------- | ------------------------------------ |
| `ANIS_PARTNERS_AUTHORITY` | Authority issued by Anis             |
| `SAMPLE_KEY_FILE`         | Protected PKCS#8 private-key file    |
| `SAMPLE_KEY_ID`           | Key id issued during enrollment      |
| `SAMPLE_ORDERS_FOLDER`    | Folder for order intent and outcomes |

Enrollment commands also accept the invitation id and token as arguments. `enrol` prints the key id, safety code, and proof state in that order. Keep the token out of shell history in a real integration.

## What each command does

The command names are `enrol`, `enrol-status`, `tour`, `profile`, `wallets`, `wallet`, `categories`, `subcategories`, `subcategory`, `cards`, `order`, `resume`, `order-status`, `owned`, `owned-card`, `reveal`, `reveal-invoice`, `diagnostic`, `signing-keys`, and `help`. Enrollment takes `--invitation <id> --token <token>`; `enrol` also accepts `--key-file <path>` and `--days <count>`. `order` accepts `--reference <text>`, `--use-allowed-debt`, `--operation <id>`, and `--expected-unit-price <amount>`.

Pass `--dry-run` to a network command to build and sign the request, print its method, URL, header names, and body, then stop before sending. Header values are never printed. `--preview` sends read requests needed by the command and stops at the first request that changes data. SDK debug logs are hidden unless `--verbose` is set. Credential values stay masked unless `--show-secrets` is explicitly supplied. The `order` command reads the wallet's current unit price and writes the operation id and exact request to the orders folder before it sends the purchase. A real service should persist that intent in its database and keep released credentials in a secret store.

The `order` and `resume` commands return exit status `4` for `unknown` or `processing`, so automation can distinguish an unresolved purchase from a completed or refused one. Keep the journal and resume the same operation id; do not start a second order for the same purchase.

Credentials are masked in console output. The local order record contains a completed response, so protect the orders folder accordingly.
