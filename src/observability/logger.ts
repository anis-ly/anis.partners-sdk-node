/** Structured partner logger; fields contain stable identifiers and never request secrets. */
export interface PartnerLogger {
  /** Emits a diagnostic event. */
  debug(message: string, fields: Record<string, unknown>): void;
  /** Emits an informational event. */
  info(message: string, fields: Record<string, unknown>): void;
  /** Emits a refusal or retry guidance event. */
  warn(message: string, fields: Record<string, unknown>): void;
  /** Emits a discarded-response or communication error. */
  error(message: string, fields: Record<string, unknown>): void;
}
