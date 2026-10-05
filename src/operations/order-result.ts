import type { RevealedCredential } from '../models/cards.js';
import type { Order } from '../models/orders.js';
import type { AnisApiError } from '../errors/anis-api-error.js';

/**
 * Result of creating or resuming an order; callers must handle all five possible outcomes.
 *
 * @remarks Credentials are present only on completion. Keeping the outcomes separate makes that one-time release
 * rule visible to callers and prevents a missed nullable-field check from losing a purchase.
 */
export type OrderResult = OrderCompleted | OrderProcessing | OrderReplayed | OrderNotPlaced | OrderOutcomeUnknown;

/** The order completed and this response carries its one-time credentials. */
export interface OrderCompleted {
  /** Discriminator for a first completion, including a recovered completion. */
  kind: 'completed';
  /** Caller-owned id that ties the completed response to the idempotency key. */
  operationId: string;
  /** Order state recorded by Anis. */
  order: Order;
  /** Credentials released by this first completion response. */
  credentials: readonly RevealedCredential[];
  /** True when the order completed but no credentials could be released. */
  codesWithheld: boolean;
}

/** Anis accepted the order but has not recorded an outcome. */
export interface OrderProcessing {
  /** Discriminator for an accepted order still processing. */
  kind: 'processing';
  /** Caller-owned id to reuse when resuming; a new id could place the cards twice. */
  operationId: string;
  /** Current order projection. */
  order: Order;
  /** Suggested wait before resuming the same operation id. */
  suggestedDelayMs: number;
  /** Location supplied by Anis, when present. */
  location?: string;
}

/** This operation id already received a terminal answer. */
export interface OrderReplayed {
  /** Discriminator for an already delivered result. */
  kind: 'replayed';
  /** Caller-owned id whose terminal answer Anis is returning again. */
  operationId: string;
  /** Recorded order state; credentials are not repeated on a replay. */
  order: Order;
}

/** Anis made a final decision that nothing was placed or charged. */
export interface OrderNotPlaced {
  /** Discriminator for a closed order refusal. */
  kind: 'notPlaced';
  /** Caller-owned id for the closed attempt. */
  operationId: string;
  /** Typed refusal with the signed problem and response metadata. */
  refusal: AnisApiError;
}

/** The call ended before the client could establish whether the order completed. */
export interface OrderOutcomeUnknown {
  /** Discriminator for an unresolved order. */
  kind: 'unknown';
  /** Caller-owned operation id to reuse when resuming. */
  operationId: string;
  /** Suggested delay before resuming the same operation id. */
  suggestedDelayMs: number;
  /** Failure or discarded answer that left the order outcome unresolved. */
  cause: unknown;
}
