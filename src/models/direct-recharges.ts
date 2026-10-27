import { parseLocalizedText, type LocalizedText } from './catalogue.js';
import { parseDirectRechargePayout, type DirectRechargePayout } from './direct-recharge-products.js';
import { parseMoney, type Money } from './money.js';
import {
  asObject,
  knownValue,
  optionalParsed,
  optionalString,
  optionalTimestamp,
  parseProductAccepted,
  requiredArray,
  requiredBoolean,
  requiredInteger,
  requiredString,
  requiredTimestamp,
  requiredUuid,
} from './model-parsing.js';

/** Merged owner state; processing acknowledgements are a separate model. */
export type DirectRechargeStatus =
  | 'unknown'
  | 'awaitingPayment'
  | 'paymentFailed'
  | 'pending'
  | 'inProgress'
  | 'suspendedDataError'
  | 'completed'
  | 'rejectedAwaitingRefund'
  | 'rejectedWithRefund';
/** Caller-provided recipient value. */
export interface DirectRechargeRecipientInput {
  /** Stable dynamic field key. */ key: string;
  /** Exact field value. */ value: string;
}
/** Persisted recipient field, including owner display metadata. */
export interface DirectRechargeRecipientValue extends DirectRechargeRecipientInput {
  /** Display name, only when provided. */ name?: LocalizedText;
  /** Display value for list fields, when provided. */ valueName?: string;
}
/** Caller-persisted purchase intent. */
export interface CreateDirectRechargeRequest {
  /** Product being purchased. */ productId: string;
  /** Positive fixed-scale payout string. */ payoutAmount: string;
  /** Expected complete wallet debit. */ expectedTotal: Money;
  /** Dynamic recipient inputs. */ recipient: readonly DirectRechargeRecipientInput[];
  /** Optional owner note. */ note?: string | undefined;
  /** Partner reconciliation reference. */ externalReference?: string | undefined;
}
/** Recipient correction while the owner is suspended for bad data. */
export interface UpdateDirectRechargeRecipientRequest {
  /** Replacement dynamic fields. */ recipient: readonly DirectRechargeRecipientInput[];
}
/** Processing acknowledgement with no fabricated owner fields. */
export interface DirectRechargeAccepted {
  /** Caller-owned operation UUID. */ operationId: string;
  /** Product discriminator. */ operationType: 'directRecharge';
  /** The money outcome remains unresolved. */ status: 'processing';
}
/** Frozen product identity on an operation. */
export interface DirectRechargeProductReference {
  /** Product UUID. */ id: string;
  /** Product title. */ title: string;
}
/** Partial-refund compatibility, present only if the owner enables it. */
export interface DirectRechargePartialRefund {
  /** Returned payout decimal string. */ refundedPayout: string;
  /** Returned wallet amount. */ refundedTotal: Money;
  /** Remaining payout decimal string. */ remainingPayout: string;
  /** Remaining wallet amount. */ remainingTotal: Money;
}
/** Wallet collection summary without recipient or proof data. */
export interface DirectRechargeSummary {
  /** Caller-owned operation UUID. */ operationId: string;
  /** Current merged owner state. */ status: DirectRechargeStatus;
  /** Owner direct recharge number. */ number: number;
  /** Original product. */ product: DirectRechargeProductReference;
  /** Original payout, not a remaining amount. */ payout: DirectRechargePayout;
  /** Original wallet debit. */ total: Money;
  /** Partner reference when provided. */ externalReference?: string;
  /** Genesis instant. */ requestedAt: Date;
  /** Completion instant when provided. */ completedAt?: Date;
  /** Whether the owner reports a partial refund. */ hasPartialRefund: boolean;
}
/** Full application-scoped owner read. */
export interface DirectRecharge extends Omit<DirectRechargeSummary, 'hasPartialRefund'> {
  /** Wallet used at genesis. */ walletId: string;
  /** Exact stored decimal rate. */ exchangeRate: string;
  /** Original wallet price. */ price: Money;
  /** Original commission. */ commission: Money;
  /** Stored dynamic recipient fields. */ recipient: readonly DirectRechargeRecipientValue[];
  /** Optional note. */ note?: string;
  /** Optional uploaded delivery proof. */ proofUrl?: string;
  /** Optional suspension or rejection reason. */ reason?: string;
  /** Conditional partial-refund details. */ partialRefund?: DirectRechargePartialRefund;
}

/** Parses explicit merged state spellings with a future-value fallback. */
export function parseDirectRechargeStatus(value: unknown): DirectRechargeStatus {
  return knownValue(value, [
    'awaitingPayment',
    'paymentFailed',
    'pending',
    'inProgress',
    'suspendedDataError',
    'completed',
    'rejectedAwaitingRefund',
    'rejectedWithRefund',
  ]);
}
/** Parses the exact processing acknowledgement. */
export function parseDirectRechargeAccepted(value: unknown): DirectRechargeAccepted {
  return parseProductAccepted(value, 'directRecharge');
}
/** Parses one recipient input without admitting unrelated properties. */
export function parseDirectRechargeRecipientInput(value: unknown): DirectRechargeRecipientInput {
  const o = asObject(value, 'DirectRechargeRecipientInput');
  return {
    key: requiredString(o, 'key', 'DirectRechargeRecipientInput'),
    value: requiredString(o, 'value', 'DirectRechargeRecipientInput'),
  };
}
/** Parses display metadata for a stored recipient field. */
export function parseDirectRechargeRecipientValue(value: unknown): DirectRechargeRecipientValue {
  const o = asObject(value, 'DirectRechargeRecipientValue');
  const valueName = optionalString(o, 'valueName', 'DirectRechargeRecipientValue');
  const name = optionalParsed(o.name, parseLocalizedText);
  return {
    ...parseDirectRechargeRecipientInput(o),
    ...(name === undefined ? {} : { name }),
    ...(valueName === undefined ? {} : { valueName }),
  };
}
/** Parses the frozen product reference. */
export function parseDirectRechargeProductReference(value: unknown): DirectRechargeProductReference {
  const o = asObject(value, 'DirectRechargeProductReference');
  return {
    id: requiredUuid(o, 'id', 'DirectRechargeProductReference'),
    title: requiredString(o, 'title', 'DirectRechargeProductReference'),
  };
}
/** Parses conditional partial-refund details without changing owner precision. */
export function parseDirectRechargePartialRefund(value: unknown): DirectRechargePartialRefund {
  const o = asObject(value, 'DirectRechargePartialRefund');
  return {
    refundedPayout: requiredString(o, 'refundedPayout', 'DirectRechargePartialRefund'),
    refundedTotal: parseMoney(o.refundedTotal),
    remainingPayout: requiredString(o, 'remainingPayout', 'DirectRechargePartialRefund'),
    remainingTotal: parseMoney(o.remainingTotal),
  };
}
function parseCommon(value: unknown): Omit<DirectRechargeSummary, 'hasPartialRefund'> {
  const o = asObject(value, 'DirectRecharge');
  const externalReference = optionalString(o, 'externalReference', 'DirectRecharge');
  const completedAt = optionalTimestamp(o, 'completedAt', 'DirectRecharge');
  return {
    operationId: requiredUuid(o, 'operationId', 'DirectRecharge'),
    status: parseDirectRechargeStatus(requiredString(o, 'status', 'DirectRecharge')),
    number: requiredInteger(o, 'number', 'DirectRecharge'),
    product: parseDirectRechargeProductReference(o.product),
    payout: parseDirectRechargePayout(o.payout),
    total: parseMoney(o.total),
    requestedAt: requiredTimestamp(o, 'requestedAt', 'DirectRecharge'),
    ...(externalReference === undefined ? {} : { externalReference }),
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}
/** Parses the list summary independently of full owner reads. */
export function parseDirectRechargeSummary(value: unknown): DirectRechargeSummary {
  const o = asObject(value, 'DirectRechargeSummary');
  return { ...parseCommon(o), hasPartialRefund: requiredBoolean(o, 'hasPartialRefund', 'DirectRechargeSummary') };
}
/** Parses a full owner read, rejecting incomplete financial data. */
export function parseDirectRecharge(value: unknown): DirectRecharge {
  const o = asObject(value, 'DirectRecharge');
  const note = optionalString(o, 'note', 'DirectRecharge');
  const proofUrl = optionalString(o, 'proofUrl', 'DirectRecharge');
  const reason = optionalString(o, 'reason', 'DirectRecharge');
  const partialRefund = optionalParsed(o.partialRefund, parseDirectRechargePartialRefund);
  return {
    ...parseCommon(o),
    walletId: requiredUuid(o, 'walletId', 'DirectRecharge'),
    exchangeRate: requiredString(o, 'exchangeRate', 'DirectRecharge'),
    price: parseMoney(o.price),
    commission: parseMoney(o.commission),
    recipient: requiredArray(o, 'recipient', 'DirectRecharge', parseDirectRechargeRecipientValue),
    ...(note === undefined ? {} : { note }),
    ...(proofUrl === undefined ? {} : { proofUrl }),
    ...(reason === undefined ? {} : { reason }),
    ...(partialRefund === undefined ? {} : { partialRefund }),
  };
}
