# Observability

The SDK uses the `@opentelemetry/api` tracer and meter named `@anis-ly/partners`. Install and configure an OpenTelemetry SDK and exporter in your application to export spans and metrics; without a registered provider, the API calls remain no-ops. The SDK package does not select an exporter or collector for you. The snippet uses the official Node SDK with OTLP exporters; install these optional packages in your application, not as dependencies of this SDK. See the [OpenTelemetry JavaScript exporter guide](https://opentelemetry.io/docs/languages/js/exporters/) for exporter choices.

```ts
import * as opentelemetry from '@opentelemetry/sdk-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
if (!endpoint) throw new Error('Set OTEL_EXPORTER_OTLP_ENDPOINT.');
const sdk = new opentelemetry.NodeSDK({
  traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
  }),
});
sdk.start(); // start this before making calls through AnisPartnersClient
```

Each API call creates a client span named `anis.partners {route}`. Its attributes are `anis.client`, `anis.route` (the route template), `http.request.method`, and `anis.operation_id` on orders. Once a verified response arrives, it adds `http.response.status_code` and, when present, `anis.request_id`. A verified refusal adds `anis.error.code`; an unusable answer sets the span status to error and adds `error.type`. Concrete wallet, card, and invoice paths are not span attributes. Operation ids belong on spans only; they are never metric attributes. A verified refusal is not tagged with `error.type`.

Metrics include:

| Instrument                                     | Kind and unit           | Attributes                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anis.partners.request.duration`               | histogram, milliseconds | `anis.client`, `anis.route`, `http.request.method`, and either `http.response.status_code` (with `anis.error.code` for a refusal) or `error.type` when no usable answer arrived                                                                                                                                       |
| `anis.partners.signature.duration`             | histogram, milliseconds | `anis.signature.profile`                                                                                                                                                                                                                                                                                              |
| `anis.partners.response.verification.failures` | counter                 | `anis.verification.failure`, one of `signature_missing`, `signature_malformed`, `signature_invalid`, `content_digest_mismatch`, `covered_components_mismatch`, `unknown_key`, `key_rejected`, `algorithm_not_supported`, `label_unexpected`, or `created_out_of_window`; only a real unverifiable response is counted |
| `anis.partners.order.outcomes`                 | counter                 | `anis.client`, `anis.order.outcome`; unresolved outcomes also include `error.type`                                                                                                                                                                                                                                    |
| `anis.partners.signing_keys.fetches`           | counter                 | `anis.fetch.reason`: `first-use`, `expired`, or `refresh`                                                                                                                                                                                                                                                             |

Order outcome metrics report `completed`, `processing`, `replayed`, and `unknown`; final `notPlaced` refusals are not counted. A caller cancellation still counts as `unknown`, then propagates the caller's cancellation error. Key-document failures and timeouts are no usable answer events, not verification failures. Content-encoded API answers are discarded and counted as `content_digest_mismatch`. An unsigned 503 is refused as `signature_missing`, so distinguish gateway unavailability from a signed API refusal using the HTTP status and error fields. Use bounded route templates and outcome values for dashboards rather than concrete resource identifiers.

The signing-key fetch counter and its `first-use`, `expired`, or `refresh` log event count only HTTP fetches. A shared-cache hit emits a debug message without an event id and does not increment that counter.

Provide a structured logger with `debug`, `info`, `warn`, and `error` methods through the client `logger` option. The event messages below include an `eventId`; the shared-cache hit debug message is the exception and has no event id:

| Event id | Level | Meaning and fields                                                              |
| -------: | ----- | ------------------------------------------------------------------------------- |
|     1000 | debug | Request signed: method, route template, profile, and key id                     |
|     1001 | debug | Request completed: method, route template, status, elapsed time, and request id |
|     1002 | warn  | Request refused: public code, status, request id, retryable, and replayed       |
|     1003 | error | Response discarded: verification failure reason                                 |
|     1004 | info  | Order completed, processing, or replayed: operation id and outcome              |
|     1005 | info  | Signing-key document fetched: reason and key count (`keyCount`)                 |
|     1006 | warn  | A response named an unpublished signing key: key id                             |
|     1007 | warn  | Signing failed or no usable answer arrived: method, route, and reason           |
|     1008 | warn  | Order outcome unknown: operation id and reason; resume the same id              |

Fields describe request signing, refusal, response discard, order outcome, or signing-key fetch without including private keys, credentials, signatures, signature bases, nonces, or enrollment tokens.

An `unknown` order outcome is the operational signal to monitor: resume it with the same operation id and exact request. A verification failure means the response was discarded and should be investigated before the result is trusted.
