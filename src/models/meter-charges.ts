import { parseLocalizedText, type LocalizedText } from './catalogue.js';
import { parseMoney, type Money } from './money.js';
import {
  asObject,
  knownValue,
  optionalParsed,
  optionalString,
  optionalTimestamp,
  parseProductAccepted,
  requiredArray,
  requiredInteger,
  requiredString,
  requiredTimestamp,
  requiredUuid,
} from './model-parsing.js';

/** Current meter lifecycle; unknown states never close recovery. */
export type MeterChargeStatus = 'unknown' | 'processing' | 'succeeded' | 'failed';
/** State of the money returned after a failed charge. */
export type MeterRefundStatus = 'unknown' | 'refunded' | 'notCharged' | 'pending';
/** Owner failure codes carried in a charge body, independent of HTTP errors. */
export type MeterFailureCode =
  | 'unknown'
  | 'meter_number_invalid'
  | 'meter_not_whitelisted'
  | 'meter_not_linked'
  | 'meter_removed'
  | 'meter_inactive'
  | 'meter_account_blocked'
  | 'meter_data_incomplete'
  | 'meter_debt_exceeds_package'
  | 'package_unavailable'
  | 'package_limit_reached'
  | 'token_not_written'
  | 'insufficient_balance'
  | 'gecol_unavailable'
  | 'charge_failed';

/** Package identity frozen on the charge. */
export interface MeterChargePackage {
  /** Package UUID. */ id: string;
  /** Owner display name. */ name: string;
  /** Electricity company package spelling. */ gecolPackageName: string;
}
/** Package priced for the authorized wallet. */
export interface MeterPackage extends MeterChargePackage {
  /** Package artwork URL, only when provided. */ logo?: string;
  /** Wallet purchase price. */ unitPrice: Money;
  /** Display retail price. */ personalPrice: Money;
  /** Business display price, only when provided. */ businessPrice?: Money;
}
/** Caller-persisted intent; the operation id belongs only in the header. */
export interface CreateMeterChargeRequest {
  /** Selected package. */ packageId: string;
  /** Exact meter spelling, including leading zeros. */ meterNumber: string;
  /** Expected wallet debit. */ expectedTotal: Money;
  /** Partner reconciliation reference. */ externalReference?: string | undefined;
}
/** Processing acknowledgement, without owner projection fields. */
export interface MeterChargeAccepted {
  /** Caller-owned operation UUID. */ operationId: string;
  /** Product discriminator. */ operationType: 'meterCharge';
  /** The charge remains unresolved. */ status: 'processing';
}
/** An electricity company token; ordering, spaces and sequence gaps are significant. */
export interface MeterToken {
  /** Owner sequence number. */ sequence: number;
  /** Token label. */ label: string;
  /** Token code with its original spaces. */ code: string;
  /** Optional owner description. */ description?: string;
}
/** Tax values passed through at upstream precision. */
export interface MeterTax {
  /** Original electricity company description. */ description: string;
  /** Decimal string at upstream scale. */ amount: string;
}
/** Complete electricity company receipt. */
export interface MeterReceipt {
  /** Electricity company receipt identifier. */ receiptNumber: string;
  /** Credited decimal string at upstream scale. */ creditedAmount: string;
  /** All ordered tokens, including key-change tokens. */ tokens: readonly MeterToken[];
  /** Original tax lines. */ taxes: readonly MeterTax[];
}
/** Owner failure with a stable known discriminator and exact wire code. */
export interface MeterFailure {
  /** Recognized failure or unknown. */ code: MeterFailureCode;
  /** Original failure spelling. */ rawCode: string;
  /** Owner translations, only when provided. */ message?: LocalizedText;
}
/** Refund state; missing amount is never replaced with zero. */
export interface MeterRefund {
  /** Current refund state. */ status: MeterRefundStatus;
  /** Refunded or pending amount, when provided. */ amount?: Money;
}
/** Wallet collection summary, without receipt or tokens. */
export interface MeterChargeSummary {
  /** Caller-owned operation UUID. */ operationId: string;
  /** Current charge state. */ status: MeterChargeStatus;
  /** Exact meter spelling. */ meterNumber: string;
  /** Frozen package identity. */ package: MeterChargePackage;
  /** Original debit. */ total: Money;
  /** Optional partner reference. */ externalReference?: string;
  /** Genesis instant. */ createdAt: Date;
  /** Success instant, when supplied. */ completedAt?: Date;
}
/** Complete application-scoped charge read. */
export interface MeterCharge extends MeterChargeSummary {
  /** Authorized wallet at genesis. */ walletId: string;
  /** Frozen retail price on every state. */ personalPrice: Money;
  /** Receipt supplied on success. */ receipt?: MeterReceipt;
  /** Failure supplied on a failed charge. */ failure?: MeterFailure;
  /** Refund supplied after failure. */ refund?: MeterRefund;
}

/** Parses known charge states without treating a future state as success. */
export function parseMeterChargeStatus(value: unknown): MeterChargeStatus {
  return knownValue(value, ['processing', 'succeeded', 'failed']);
}
/** Parses the closed known refund states leniently. */
export function parseMeterRefundStatus(value: unknown): MeterRefundStatus {
  return knownValue(value, ['refunded', 'notCharged', 'pending']);
}
/** Resolves snake-case body codes using explicit published spellings. */
export function parseMeterFailureCode(value: unknown): MeterFailureCode {
  return knownValue(value, [
    'meter_number_invalid',
    'meter_not_whitelisted',
    'meter_not_linked',
    'meter_removed',
    'meter_inactive',
    'meter_account_blocked',
    'meter_data_incomplete',
    'meter_debt_exceeds_package',
    'package_unavailable',
    'package_limit_reached',
    'token_not_written',
    'insufficient_balance',
    'gecol_unavailable',
    'charge_failed',
  ]);
}
/** Parses the exact three-member acknowledgement. */
export function parseMeterChargeAccepted(value: unknown): MeterChargeAccepted {
  return parseProductAccepted(value, 'meterCharge');
}
/** Parses the frozen package identity. */
export function parseMeterChargePackage(value: unknown): MeterChargePackage {
  const o = asObject(value, 'MeterChargePackage');
  return {
    id: requiredUuid(o, 'id', 'MeterChargePackage'),
    name: requiredString(o, 'name', 'MeterChargePackage'),
    gecolPackageName: requiredString(o, 'gecolPackageName', 'MeterChargePackage'),
  };
}
/** Parses wallet pricing without inventing an absent business price. */
export function parseMeterPackage(value: unknown): MeterPackage {
  const o = asObject(value, 'MeterPackage');
  const businessPrice = optionalParsed(o.businessPrice, parseMoney);
  const logo = optionalString(o, 'logo', 'MeterPackage');
  return {
    ...parseMeterChargePackage(o),
    ...(logo === undefined ? {} : { logo }),
    unitPrice: parseMoney(o.unitPrice),
    personalPrice: parseMoney(o.personalPrice),
    ...(businessPrice === undefined ? {} : { businessPrice }),
  };
}
/** Parses a token without normalizing its code. */
export function parseMeterToken(value: unknown): MeterToken {
  const o = asObject(value, 'MeterToken');
  const description = optionalString(o, 'description', 'MeterToken');
  return {
    sequence: requiredInteger(o, 'sequence', 'MeterToken'),
    label: requiredString(o, 'label', 'MeterToken'),
    code: requiredString(o, 'code', 'MeterToken'),
    ...(description === undefined ? {} : { description }),
  };
}
/** Parses a tax without changing its upstream decimal scale. */
export function parseMeterTax(value: unknown): MeterTax {
  const o = asObject(value, 'MeterTax');
  return { description: requiredString(o, 'description', 'MeterTax'), amount: requiredString(o, 'amount', 'MeterTax') };
}
/** Parses all receipt tokens in their original order. */
export function parseMeterReceipt(value: unknown): MeterReceipt {
  const o = asObject(value, 'MeterReceipt');
  return {
    receiptNumber: requiredString(o, 'receiptNumber', 'MeterReceipt'),
    creditedAmount: requiredString(o, 'creditedAmount', 'MeterReceipt'),
    tokens: requiredArray(o, 'tokens', 'MeterReceipt', parseMeterToken),
    taxes: requiredArray(o, 'taxes', 'MeterReceipt', parseMeterTax),
  };
}
/** Parses known and future owner failures. */
export function parseMeterFailure(value: unknown): MeterFailure {
  const o = asObject(value, 'MeterFailure');
  const rawCode = requiredString(o, 'code', 'MeterFailure');
  const message = optionalParsed(o.message, parseLocalizedText);
  return { code: parseMeterFailureCode(rawCode), rawCode, ...(message === undefined ? {} : { message }) };
}
/** Parses a refund without supplying a missing amount. */
export function parseMeterRefund(value: unknown): MeterRefund {
  const o = asObject(value, 'MeterRefund');
  const amount = optionalParsed(o.amount, parseMoney);
  return {
    status: parseMeterRefundStatus(requiredString(o, 'status', 'MeterRefund')),
    ...(amount === undefined ? {} : { amount }),
  };
}
/** Parses the collection shape independently of a full read. */
export function parseMeterChargeSummary(value: unknown): MeterChargeSummary {
  const o = asObject(value, 'MeterChargeSummary');
  const externalReference = optionalString(o, 'externalReference', 'MeterChargeSummary');
  const completedAt = optionalTimestamp(o, 'completedAt', 'MeterChargeSummary');
  return {
    operationId: requiredUuid(o, 'operationId', 'MeterChargeSummary'),
    status: parseMeterChargeStatus(requiredString(o, 'status', 'MeterChargeSummary')),
    meterNumber: requiredString(o, 'meterNumber', 'MeterChargeSummary'),
    package: parseMeterChargePackage(o.package),
    total: parseMoney(o.total),
    createdAt: requiredTimestamp(o, 'createdAt', 'MeterChargeSummary'),
    ...(externalReference === undefined ? {} : { externalReference }),
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}
/** Parses a full owner read; acknowledgements cannot masquerade as financial state. */
export function parseMeterCharge(value: unknown): MeterCharge {
  const o = asObject(value, 'MeterCharge');
  const receipt = optionalParsed(o.receipt, parseMeterReceipt);
  const failure = optionalParsed(o.failure, parseMeterFailure);
  const refund = optionalParsed(o.refund, parseMeterRefund);
  return {
    ...parseMeterChargeSummary(o),
    walletId: requiredUuid(o, 'walletId', 'MeterCharge'),
    personalPrice: parseMoney(o.personalPrice),
    ...(receipt === undefined ? {} : { receipt }),
    ...(failure === undefined ? {} : { failure }),
    ...(refund === undefined ? {} : { refund }),
  };
}
