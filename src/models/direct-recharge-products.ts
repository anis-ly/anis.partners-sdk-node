import { parseLocalizedText, type LocalizedText } from './catalogue.js';
import { parseMoney, type Money } from './money.js';
import {
  asObject,
  knownValue,
  optionalParsed,
  optionalString,
  requiredArray,
  requiredBoolean,
  requiredInteger,
  requiredString,
  requiredUuid,
} from './model-parsing.js';

/** Published product kinds, with a lenient read fallback. */
export type DirectRechargeProductType = 'unknown' | 'external' | 'billing';
/** Dynamic recipient field kinds. */
export type DirectRechargeFieldKind = 'unknown' | 'text' | 'list' | 'note';
/** Person a dynamic field describes. */
export type DirectRechargeFieldFor = 'unknown' | 'recipient' | 'sender';
/** Quote input denomination. Other request values are rejected locally. */
export type DirectRechargeAmountIn = 'lyd' | 'fx';
/** Owner display currency; no ISO code is inferred. */
export interface DirectRechargeCurrency {
  /** Owner currency name. */ name: string;
}
/** Foreign payout, independent of wallet Money. */
export interface DirectRechargePayout {
  /** Exact decimal spelling. */ amount: string;
  /** Display currency. */ currency: DirectRechargeCurrency;
}
/** Product category. */
export interface DirectRechargeCategory {
  /** Category UUID. */ id: string;
  /** Owner display name. */ name: string;
  /** Optional artwork URL. */ icon?: string;
}
/** Selected wallet-tier limits, without fabricated maxima. */
export interface DirectRechargeLimits {
  /** Minimum wallet debit when provided. */ minimumTotal?: Money;
  /** Maximum wallet debit when provided. */ maximumTotal?: Money;
  /** Minimum payout decimal string when provided. */ minimumPayout?: string;
  /** Maximum payout decimal string when provided. */ maximumPayout?: string;
}
/** Product priced for a wallet. */
export interface DirectRechargeProductSummary {
  /** Product UUID. */ id: string;
  /** Display title. */ title: string;
  /** Optional owner description. */ description?: string;
  /** Published product kind. */ type: DirectRechargeProductType;
  /** Optional category. */ category?: DirectRechargeCategory;
  /** Display payout currency. */ payoutCurrency: DirectRechargeCurrency;
  /** Whether this wallet tier can buy it. */ available: boolean;
  /** Selected tier limits when provided. */ limits?: DirectRechargeLimits;
}
/** Product detail adds its required recipient field definitions. */
export interface DirectRechargeProduct extends DirectRechargeProductSummary {
  /** Dynamic fields in owner order. */ recipientFields: readonly DirectRechargeRecipientField[];
}
/** Owner-defined recipient input metadata. */
export interface DirectRechargeRecipientField {
  /** Stable field key. */ key: string;
  /** Display name, only when provided. */ name?: LocalizedText;
  /** Input control kind. */ kind: DirectRechargeFieldKind;
  /** Wire property identifying recipient or sender. */ for: DirectRechargeFieldFor;
  /** Owner display order. */ order: number;
  /** Optional regular expression. */ validation?: string;
  /** Optional validation text. */ validationMessage?: LocalizedText;
}
/** Available location for a list field. */
export interface DirectRechargeLocation {
  /** Location UUID. */ id: string;
  /** Display name. */ name: string;
}
/** Price check without a reservation. */
export interface DirectRechargeQuote {
  /** Product UUID. */ productId: string;
  /** Exact payout and display currency. */ payout: DirectRechargePayout;
  /** Decimal rate retaining owner precision. */ exchangeRate: string;
  /** Wallet price. */ price: Money;
  /** Wallet commission. */ commission: Money;
  /** Complete wallet debit. */ total: Money;
}

/** Parses a product kind by its published spelling. */
export function parseDirectRechargeProductType(value: unknown): DirectRechargeProductType {
  return knownValue(value, ['external', 'billing']);
}
/** Parses a dynamic field kind. */
export function parseDirectRechargeFieldKind(value: unknown): DirectRechargeFieldKind {
  return knownValue(value, ['text', 'list', 'note']);
}
/** Parses a dynamic field audience. */
export function parseDirectRechargeFieldFor(value: unknown): DirectRechargeFieldFor {
  return knownValue(value, ['recipient', 'sender']);
}
/** Parses a quote denomination; request typos must not silently choose a currency. */
export function parseDirectRechargeAmountIn(value: unknown): DirectRechargeAmountIn {
  if (value !== 'lyd' && value !== 'fx') throw new TypeError('amountIn must be lyd or fx.');
  return value;
}
/** Parses a display currency without treating it as Money. */
export function parseDirectRechargeCurrency(value: unknown): DirectRechargeCurrency {
  const o = asObject(value, 'DirectRechargeCurrency');
  return { name: requiredString(o, 'name', 'DirectRechargeCurrency') };
}
/** Preserves the exact payout spelling. */
export function parseDirectRechargePayout(value: unknown): DirectRechargePayout {
  const o = asObject(value, 'DirectRechargePayout');
  return {
    amount: requiredString(o, 'amount', 'DirectRechargePayout'),
    currency: parseDirectRechargeCurrency(o.currency),
  };
}
/** Parses a category without synthesizing artwork. */
export function parseDirectRechargeCategory(value: unknown): DirectRechargeCategory {
  const o = asObject(value, 'DirectRechargeCategory');
  const icon = optionalString(o, 'icon', 'DirectRechargeCategory');
  return {
    id: requiredUuid(o, 'id', 'DirectRechargeCategory'),
    name: requiredString(o, 'name', 'DirectRechargeCategory'),
    ...(icon === undefined ? {} : { icon }),
  };
}
/** Parses only supplied tier limits. */
export function parseDirectRechargeLimits(value: unknown): DirectRechargeLimits {
  const o = asObject(value, 'DirectRechargeLimits');
  const minimumTotal = optionalParsed(o.minimumTotal, parseMoney);
  const maximumTotal = optionalParsed(o.maximumTotal, parseMoney);
  const minimumPayout = optionalString(o, 'minimumPayout', 'DirectRechargeLimits');
  const maximumPayout = optionalString(o, 'maximumPayout', 'DirectRechargeLimits');
  return {
    ...(minimumTotal === undefined ? {} : { minimumTotal }),
    ...(maximumTotal === undefined ? {} : { maximumTotal }),
    ...(minimumPayout === undefined ? {} : { minimumPayout }),
    ...(maximumPayout === undefined ? {} : { maximumPayout }),
  };
}
/** Parses a wallet product summary. */
export function parseDirectRechargeProductSummary(value: unknown): DirectRechargeProductSummary {
  const o = asObject(value, 'DirectRechargeProductSummary');
  const description = optionalString(o, 'description', 'DirectRechargeProductSummary');
  const category = optionalParsed(o.category, parseDirectRechargeCategory);
  const limits = optionalParsed(o.limits, parseDirectRechargeLimits);
  return {
    id: requiredUuid(o, 'id', 'DirectRechargeProductSummary'),
    title: requiredString(o, 'title', 'DirectRechargeProductSummary'),
    type: parseDirectRechargeProductType(requiredString(o, 'type', 'DirectRechargeProductSummary')),
    payoutCurrency: parseDirectRechargeCurrency(o.payoutCurrency),
    available: requiredBoolean(o, 'available', 'DirectRechargeProductSummary'),
    ...(description === undefined ? {} : { description }),
    ...(category === undefined ? {} : { category }),
    ...(limits === undefined ? {} : { limits }),
  };
}
/** Parses dynamic fields, including the literal wire property for. */
export function parseDirectRechargeRecipientField(value: unknown): DirectRechargeRecipientField {
  const o = asObject(value, 'DirectRechargeRecipientField');
  const validation = optionalString(o, 'validation', 'DirectRechargeRecipientField');
  const validationMessage = optionalParsed(o.validationMessage, parseLocalizedText);
  const name = optionalParsed(o.name, parseLocalizedText);
  return {
    key: requiredString(o, 'key', 'DirectRechargeRecipientField'),
    ...(name === undefined ? {} : { name }),
    kind: parseDirectRechargeFieldKind(requiredString(o, 'kind', 'DirectRechargeRecipientField')),
    for: parseDirectRechargeFieldFor(requiredString(o, 'for', 'DirectRechargeRecipientField')),
    order: requiredInteger(o, 'order', 'DirectRechargeRecipientField'),
    ...(validation === undefined ? {} : { validation }),
    ...(validationMessage === undefined ? {} : { validationMessage }),
  };
}
/** Parses complete detail without stripping dynamic fields. */
export function parseDirectRechargeProduct(value: unknown): DirectRechargeProduct {
  const o = asObject(value, 'DirectRechargeProduct');
  return {
    ...parseDirectRechargeProductSummary(o),
    recipientFields: requiredArray(o, 'recipientFields', 'DirectRechargeProduct', parseDirectRechargeRecipientField),
  };
}
/** Parses a location. */
export function parseDirectRechargeLocation(value: unknown): DirectRechargeLocation {
  const o = asObject(value, 'DirectRechargeLocation');
  return {
    id: requiredUuid(o, 'id', 'DirectRechargeLocation'),
    name: requiredString(o, 'name', 'DirectRechargeLocation'),
  };
}
/** Parses a quote with exact rate and wallet amounts. */
export function parseDirectRechargeQuote(value: unknown): DirectRechargeQuote {
  const o = asObject(value, 'DirectRechargeQuote');
  return {
    productId: requiredUuid(o, 'productId', 'DirectRechargeQuote'),
    payout: parseDirectRechargePayout(o.payout),
    exchangeRate: requiredString(o, 'exchangeRate', 'DirectRechargeQuote'),
    price: parseMoney(o.price),
    commission: parseMoney(o.commission),
    total: parseMoney(o.total),
  };
}
