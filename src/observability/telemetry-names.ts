/**
 * Stable OpenTelemetry names for dashboards and host-side instrumentation configuration.
 *
 * @remarks These constants keep integrations aligned with the SDK's bounded dimensions so telemetry does not split
 * into incompatible series after an application upgrade.
 */
export const AnisPartnersTelemetry = {
  /** Instrumentation scope used for every SDK span and metric. */
  scope: '@anis-ly/partners',
  /** Stable low-cardinality attribute names. */
  attributes: {
    client: 'anis.client',
    route: 'anis.route',
    method: 'http.request.method',
    statusCode: 'http.response.status_code',
    errorType: 'error.type',
    errorCode: 'anis.error.code',
    operationId: 'anis.operation_id',
    requestId: 'anis.request_id',
  },
  /** Metric instrument names emitted by the SDK. */
  instruments: {
    requestDuration: 'anis.partners.request.duration',
    signatureDuration: 'anis.partners.signature.duration',
    verificationFailures: 'anis.partners.response.verification.failures',
    orderOutcomes: 'anis.partners.order.outcomes',
    signingKeyFetches: 'anis.partners.signing_keys.fetches',
  },
} as const;
