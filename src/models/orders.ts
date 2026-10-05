import {
  asObject,
  optionalBoolean,
  optionalInteger,
  optionalString,
  optionalTimestamp,
  optionalUuid,
  requiredUuid,
} from './model-parsing.js';
import { parseMoney, type Money } from './money.js';
import { parseRevealedCredential, type RevealedCredential } from './cards.js';

/**
 * Order lifecycle state. Unknown future values stay readable as unknown.
 *
 * @remarks The parser maps this wire enum explicitly because serializer defaults differ between runtimes. Order
 * outcomes still depend on the response and replay marker, never on a future status string alone.
 */
export type OrderStatus = 'unknown' | 'processing' | 'recoveryExhausted' | 'completed' | 'failed';

/**
 * What a partner wants to buy. Prices remain exact decimal strings through Money serialization.
 *
 * @remarks The gateway rejects unknown request members and compares the total to exact unit-price multiplication;
 * floating-point arithmetic can therefore turn an apparently valid order into a refusal.
 */
export interface CreateOrderRequest {
  /** Catalogue card being purchased. */
  cardId: string;
  /** Number of cards, within the live catalogue limits. */
  quantity: number;
  /** Price read from the catalogue, echoed to detect price changes. */
  expectedUnitPrice: Money;
  /** Exact expected unit price multiplied by quantity. */
  expectedTotal: Money;
  /** Partner's own reference, when useful for reconciliation. */
  externalReference?: string;
  /** Explicit consent to use an allowed owner debt balance. */
  useAllowedDebt?: boolean;
}

/**
 * An order projection returned by create, resume, or lookup.
 *
 * @remarks Credentials appear only on the first completion answer. A replay or lookup is state-only, so use the typed
 * order result for a compile-time distinction before handling credentials.
 */
export interface Order {
  /** Same UUID the caller sent as Idempotency-Key. */
  operationId: string;
  /** Current owner-reported order state. */
  status: OrderStatus;
  /** Owner invoice UUID once one exists. */
  invoiceId?: string;
  /** Wallet UUID the order used. */
  walletId?: string;
  /** Catalogue card UUID. */
  cardId?: string;
  /** Number of cards. */
  quantity?: number;
  /** Total amount charged. */
  total?: Money;
  /** Credentials, only on the first response that reports completion. */
  soldCards?: readonly RevealedCredential[];
  /** Completion instant. */
  completedAt?: Date;
  /** Partner's reference from the create request. */
  externalReference?: string;
  /** Recorded refusal code when a lookup reports a failed order. */
  failureCode?: string;
  /** Whether the completed order's credentials were withheld; absent means the API did not state it. */
  codesWithheld?: boolean;
}

/** Parses a wire order and maps its lifecycle enum explicitly to avoid serializer-default drift. */
export function parseOrder(json: unknown): Order {
  const object = asObject(json, 'Order');
  const invoiceId = optionalUuid(object, 'invoiceId', 'Order');
  const walletId = optionalUuid(object, 'walletId', 'Order');
  const cardId = optionalUuid(object, 'cardId', 'Order');
  const quantity = optionalInteger(object, 'quantity', 'Order');
  const total = object.total === undefined || object.total === null ? undefined : parseMoney(object.total);
  const soldCards = parseOptionalCredentials(object.soldCards);
  const completedAt = optionalTimestamp(object, 'completedAt', 'Order');
  const externalReference = optionalString(object, 'externalReference', 'Order');
  const failureCode = optionalString(object, 'failureCode', 'Order');
  const codesWithheld = optionalBoolean(object, 'codesWithheld', 'Order');
  return {
    operationId: requiredUuid(object, 'operationId', 'Order'),
    status: parseOrderStatus(object.status),
    ...(invoiceId === undefined ? {} : { invoiceId }),
    ...(walletId === undefined ? {} : { walletId }),
    ...(cardId === undefined ? {} : { cardId }),
    ...(quantity === undefined ? {} : { quantity }),
    ...(total === undefined ? {} : { total }),
    ...(soldCards === undefined ? {} : { soldCards }),
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(externalReference === undefined ? {} : { externalReference }),
    ...(failureCode === undefined ? {} : { failureCode }),
    ...(codesWithheld === undefined ? {} : { codesWithheld }),
  };
}

/** Parses known order-state spellings and treats every new or missing value as unknown. */
export function parseOrderStatus(value: unknown): OrderStatus {
  if (typeof value !== 'string') {
    return 'unknown';
  }
  switch (value.toLowerCase()) {
    case 'processing':
      return 'processing';
    case 'recoveryexhausted':
      return 'recoveryExhausted';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    default:
      return 'unknown';
  }
}

function parseOptionalCredentials(value: unknown): readonly RevealedCredential[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new TypeError('Order.soldCards must be an array when present.');
  }
  return value.map(parseRevealedCredential);
}
