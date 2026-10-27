/** Exact incoming HTTP request, captured before JSON middleware changes its body. */
export interface VerifiableWebhook {
  /** Actual HTTP method received. */
  method: string;
  /** Actual absolute target URI, including the original query. */
  targetUri: string;
  /** Case-insensitive field names; duplicate spellings are refused. */
  headers: Readonly<Record<string, string>>;
  /** Original bytes used for digest verification, without decoding or reserialization. */
  body: Uint8Array;
}

/** Trusted receiver configuration, supplied independently of incoming headers. */
export interface WebhookReceiverOptions {
  /** Externally registered absolute HTTPS URL, including its query. */
  configuredUrl: string;
  /** Application UUID expected on this endpoint. */
  applicationId: string;
}
