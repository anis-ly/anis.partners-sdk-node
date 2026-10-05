import { inspect } from 'node:util';
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
import { parseLocalizedText, type LocalizedText } from './catalogue.js';

/** A sold card as a masked projection; plaintext is never present here. */
export interface MaskedCard {
  /** Sold-card UUID used by a single-card reveal. */
  id: string;
  /** Order that produced this card, when the API exposes it. */
  orderOperationId?: string;
  /** Owner invoice needed for invoice-level reveal. */
  invoiceId?: string;
  /** Catalogue card summary. */
  card?: MaskedCardProduct;
  /** Masked serial for identification without disclosing the credential. */
  serialNumberMasked?: string;
  /** Whether Anis currently permits the credential to be revealed. */
  credentialAvailable: boolean;
  /** Purchase instant, when supplied. */
  purchasedAt?: Date;
  /** Amount originally charged per card, including after a refund. */
  unitPrice?: Money;
  /** Last calendar day the card can be used. */
  expiryDate?: string;
  /** Number printed on the owner invoice. */
  invoiceNumber?: number;
  /** Printed face value when supplied. */
  faceValue?: string;
  /** Catalogue subcategory summary. */
  subcategory?: MaskedCardSubcategory;
}

/** A catalogue subcategory summary attached to a sold card. */
export interface MaskedCardSubcategory {
  /** Subcategory UUID. */
  id: string;
  /** Localized name when supplied. */
  name?: LocalizedText;
}

/** A catalogue product summary attached to a sold card or revealed credential. */
export interface MaskedCardProduct {
  /** Card UUID. */
  id: string;
  /** Localized name when supplied. */
  name?: LocalizedText;
}

/**
 * Credential plaintext returned only by a protected reveal or first order completion.
 *
 * @remarks This is the only public model that carries a voucher or serial. Redacting its string form prevents a
 * careless log interpolation from disclosing credentials.
 */
export interface RevealedCredential {
  /** Sold-card UUID this credential belongs to. */
  soldCardId: string;
  /** Serial number; keep it out of logs and telemetry. */
  serialNumber?: string;
  /** Voucher code; keep it out of logs and telemetry. */
  voucher?: string;
  /** Reveal instant when supplied. */
  revealedAt?: Date;
  /** Last calendar day the card can be used. */
  expiryDate?: string;
  /** Invoice UUID, present on reveal routes. */
  invoiceId?: string;
  /** Product summary, present on reveal routes. */
  card?: MaskedCardProduct;
  /** Purchase instant, present on reveal routes. */
  purchasedAt?: Date;
  /** Redacted representation for accidental string interpolation. */
  toString(): string;
  /** Redacted representation for Node's recursive native inspection. */
  [inspect.custom](): string;
}

/** All credentials released for one invoice, or none when the invoice cannot be revealed. */
export interface RevealedCredentialCollection {
  /** Credentials on this invoice, capped by the public contract. */
  items: readonly RevealedCredential[];
}

/** Parses a masked sold-card projection. */
export function parseMaskedCard(json: unknown): MaskedCard {
  const object = asObject(json, 'MaskedCard');
  const orderOperationId = optionalUuid(object, 'orderOperationId', 'MaskedCard');
  const invoiceId = optionalUuid(object, 'invoiceId', 'MaskedCard');
  const card = parseOptionalProduct(object, 'card');
  const serialNumberMasked = optionalString(object, 'serialNumberMasked', 'MaskedCard');
  const purchasedAt = optionalTimestamp(object, 'purchasedAt', 'MaskedCard');
  const unitPrice =
    object.unitPrice === undefined || object.unitPrice === null ? undefined : parseMoney(object.unitPrice);
  const expiryDate = optionalDateOnly(object, 'expiryDate', 'MaskedCard');
  const invoiceNumber = optionalInteger(object, 'invoiceNumber', 'MaskedCard');
  const faceValue = optionalString(object, 'faceValue', 'MaskedCard');
  const subcategory = parseOptionalSubcategory(object);
  return {
    id: requiredUuid(object, 'id', 'MaskedCard'),
    credentialAvailable: optionalBoolean(object, 'credentialAvailable', 'MaskedCard') ?? false,
    ...(orderOperationId === undefined ? {} : { orderOperationId }),
    ...(invoiceId === undefined ? {} : { invoiceId }),
    ...(card === undefined ? {} : { card }),
    ...(serialNumberMasked === undefined ? {} : { serialNumberMasked }),
    ...(purchasedAt === undefined ? {} : { purchasedAt }),
    ...(unitPrice === undefined ? {} : { unitPrice }),
    ...(expiryDate === undefined ? {} : { expiryDate }),
    ...(invoiceNumber === undefined ? {} : { invoiceNumber }),
    ...(faceValue === undefined ? {} : { faceValue }),
    ...(subcategory === undefined ? {} : { subcategory }),
  };
}

/** Parses a revealed credential and keeps its string representation redacted. */
export function parseRevealedCredential(json: unknown): RevealedCredential {
  const object = asObject(json, 'RevealedCredential');
  const serialNumber = optionalString(object, 'serialNumber', 'RevealedCredential');
  const voucher = optionalString(object, 'voucher', 'RevealedCredential');
  const revealedAt = optionalTimestamp(object, 'revealedAt', 'RevealedCredential');
  const expiryDate = optionalDateOnly(object, 'expiryDate', 'RevealedCredential');
  const invoiceId = optionalUuid(object, 'invoiceId', 'RevealedCredential');
  const card = parseOptionalProduct(object, 'card');
  const purchasedAt = optionalTimestamp(object, 'purchasedAt', 'RevealedCredential');
  return {
    soldCardId: requiredUuid(object, 'soldCardId', 'RevealedCredential'),
    ...(serialNumber === undefined ? {} : { serialNumber }),
    ...(voucher === undefined ? {} : { voucher }),
    ...(revealedAt === undefined ? {} : { revealedAt }),
    ...(expiryDate === undefined ? {} : { expiryDate }),
    ...(invoiceId === undefined ? {} : { invoiceId }),
    ...(card === undefined ? {} : { card }),
    ...(purchasedAt === undefined ? {} : { purchasedAt }),
    toString() {
      return `RevealedCredential { SoldCardId = ${this.soldCardId}, Secret = <redacted> }`;
    },
    [inspect.custom]() {
      return `RevealedCredential { SoldCardId = ${this.soldCardId}, Secret = <redacted> }`;
    },
  };
}

/** Parses an invoice reveal collection. */
export function parseRevealedCredentialCollection(json: unknown): RevealedCredentialCollection {
  const object = asObject(json, 'RevealedCredentialCollection');
  const items = object.items ?? [];
  if (!Array.isArray(items)) {
    throw new TypeError('RevealedCredentialCollection.items must be an array.');
  }
  return { items: items.map(parseRevealedCredential) };
}

function parseOptionalProduct(object: Record<string, unknown>, field: string): MaskedCardProduct | undefined {
  const value = object[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  const nested = asObject(value, `MaskedCard.${field}`);
  const name = nested.name === undefined || nested.name === null ? undefined : parseLocalizedText(nested.name);
  return {
    id: requiredUuid(nested, 'id', `MaskedCard.${field}`),
    ...(name === undefined ? {} : { name }),
  };
}

function parseOptionalSubcategory(object: Record<string, unknown>): MaskedCardSubcategory | undefined {
  const value = object.subcategory;
  if (value === undefined || value === null) {
    return undefined;
  }
  const nested = asObject(value, 'MaskedCard.subcategory');
  const name = nested.name === undefined || nested.name === null ? undefined : parseLocalizedText(nested.name);
  return {
    id: requiredUuid(nested, 'id', 'MaskedCard.subcategory'),
    ...(name === undefined ? {} : { name }),
  };
}

function optionalDateOnly(object: Record<string, unknown>, field: string, label: string): string | undefined {
  const value = optionalString(object, field, label);
  if (value === undefined) {
    return undefined;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new TypeError(`${label}.${field} must be a calendar date.`);
  }
  return value;
}
