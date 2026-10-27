/** Frozen webhook signature profile, independent of the response profile and its retirement policy. */
export const PartnerWebhookSignatureBase = {
  /** Ordered coverage required on every delivery. */
  identifiers: [
    '@method',
    '@target-uri',
    'content-digest',
    'webhook-id',
    'anis-webhook-attempt',
    'anis-application-id',
  ] as const,
  /** Five-minute signing lifetime and maximum creation skew. */
  LIFETIME_SECONDS: 300,

  /** Rebuilds UTF-8 signature bytes with LF separators and no trailing newline. */
  build(
    method: string,
    targetUri: string,
    digest: string,
    eventId: string,
    attempt: string,
    applicationId: string,
    signatureParams: string,
  ): Uint8Array {
    return new TextEncoder().encode(
      [
        `"@method": ${method}`,
        `"@target-uri": ${targetUri}`,
        `"content-digest": ${digest}`,
        `"webhook-id": ${eventId}`,
        `"anis-webhook-attempt": ${attempt}`,
        `"anis-application-id": ${applicationId}`,
        `"@signature-params": ${signatureParams}`,
      ].join('\n'),
    );
  },
};
