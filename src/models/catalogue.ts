import {
  asObject,
  optionalBoolean,
  optionalInteger,
  optionalString,
  optionalUuid,
  requiredUuid,
} from './model-parsing.js';
import { parseMoney, type Money } from './money.js';

/** Owner-supplied Arabic and English text; either translation can be absent. */
export interface LocalizedText {
  /** Arabic text when supplied. */
  ar?: string;
  /** English text when supplied. */
  en?: string;
}

/** Category source. Unknown wire values remain readable if Anis adds a category kind. */
export type CatalogueCategoryType = 'unknown' | 'local' | 'international';

/** A published catalogue category. */
export interface CatalogueCategory {
  /** Category UUID in canonical lower-case form. */
  id: string;
  /** Display name, which the owner may provide in either language. */
  name?: LocalizedText;
  /** Description, which the owner may provide in either language. */
  description?: LocalizedText;
  /** Logo URL when present. */
  logo?: string;
  /** Local, international, or unknown when the SDK has not seen a new value. */
  type: CatalogueCategoryType;
  /** Whether stock is live under the current owner rules. */
  inStock: boolean;
  /** Position chosen by the owner. */
  displayOrder: number;
}

/** A published catalogue subcategory, including buyer-facing terms where present. */
export interface CatalogueSubcategory {
  /** Subcategory UUID. */
  id: string;
  /** Parent category UUID. */
  categoryId: string;
  /** Display name, if supplied. */
  name?: LocalizedText;
  /** Description, if supplied. */
  description?: LocalizedText;
  /** Logo URL when present. */
  logo?: string;
  /** Whether the owner marked this subcategory as a best seller. */
  isBestSelling: boolean;
  /** Position chosen by the owner. */
  displayOrder: number;
  /** Whether it is currently available. */
  available: boolean;
  /** Buyer-facing terms to show before purchase; absent when the owner supplied none. */
  disclaimer?: LocalizedText;
}

/** A purchasable card and the price this wallet pays for it. */
export interface CatalogueCard {
  /** Card UUID used in an order. */
  id: string;
  /** Parent subcategory UUID. */
  subcategoryId: string;
  /** Display name, if supplied. */
  name?: LocalizedText;
  /** Printed face value, when the card has one. */
  faceValue?: string;
  /** The current unit price to return as expectedUnitPrice; absent when this wallet cannot buy it. */
  unitPrice?: Money;
  /** Business price for comparison and display; an order at a different value may be refused. */
  businessPrice?: Money;
  /** Retail price for display, present only above business price. */
  personalPrice?: Money;
  /** Whether a special offer applies. */
  hasSpecialOffer: boolean;
  /** Display-only offer price when a special offer applies. */
  specialOfferPrice?: Money;
  /** Whether the card is live under current owner rules. */
  available: boolean;
  /** Lowest quantity accepted in one order, when constrained. */
  minimumQuantity?: number;
  /** Highest quantity accepted in one order, when constrained. */
  maximumQuantity?: number;
}

/** One cursor-paged result. Pass nextCursor to continue until it is absent. */
export interface Page<T> {
  /** Values on this page. */
  items: readonly T[];
  /** Cursor for the next page, absent when the list is exhausted. */
  nextCursor?: string;
}

/** Parses owner-supplied localized text without inventing a fallback. */
export function parseLocalizedText(json: unknown): LocalizedText {
  const object = asObject(json, 'LocalizedText');
  const ar = optionalString(object, 'ar', 'LocalizedText');
  const en = optionalString(object, 'en', 'LocalizedText');
  return { ...(ar === undefined ? {} : { ar }), ...(en === undefined ? {} : { en }) };
}

/** Parses category type leniently so a newly published value does not break the whole response. */
export function parseCatalogueCategoryType(value: unknown): CatalogueCategoryType {
  if (typeof value !== 'string') {
    return 'unknown';
  }
  switch (value.toLowerCase()) {
    case 'local':
      return 'local';
    case 'international':
      return 'international';
    default:
      return 'unknown';
  }
}

/** Parses a catalogue category, retaining unknown category kinds as unknown. */
export function parseCatalogueCategory(json: unknown): CatalogueCategory {
  const object = asObject(json, 'CatalogueCategory');
  const name = parseOptionalLocalized(object, 'name', 'CatalogueCategory');
  const description = parseOptionalLocalized(object, 'description', 'CatalogueCategory');
  const logo = optionalString(object, 'logo', 'CatalogueCategory');
  return {
    id: requiredUuid(object, 'id', 'CatalogueCategory'),
    type: parseCatalogueCategoryType(object.type),
    inStock: optionalBoolean(object, 'inStock', 'CatalogueCategory') ?? false,
    displayOrder: optionalInteger(object, 'displayOrder', 'CatalogueCategory') ?? 0,
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(logo === undefined ? {} : { logo }),
  };
}

/** Parses a catalogue subcategory and preserves its optional disclaimer. */
export function parseCatalogueSubcategory(json: unknown): CatalogueSubcategory {
  const object = asObject(json, 'CatalogueSubcategory');
  const name = parseOptionalLocalized(object, 'name', 'CatalogueSubcategory');
  const description = parseOptionalLocalized(object, 'description', 'CatalogueSubcategory');
  const logo = optionalString(object, 'logo', 'CatalogueSubcategory');
  const disclaimer = parseOptionalLocalized(object, 'disclaimer', 'CatalogueSubcategory');
  return {
    id: requiredUuid(object, 'id', 'CatalogueSubcategory'),
    categoryId: optionalUuid(object, 'categoryId', 'CatalogueSubcategory') ?? '00000000-0000-0000-0000-000000000000',
    isBestSelling: optionalBoolean(object, 'isBestSelling', 'CatalogueSubcategory') ?? false,
    displayOrder: optionalInteger(object, 'displayOrder', 'CatalogueSubcategory') ?? 0,
    available: optionalBoolean(object, 'available', 'CatalogueSubcategory') ?? false,
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(logo === undefined ? {} : { logo }),
    ...(disclaimer === undefined ? {} : { disclaimer }),
  };
}

/** Parses a catalogue card without recalculating any owner-provided price. */
export function parseCatalogueCard(json: unknown): CatalogueCard {
  const object = asObject(json, 'CatalogueCard');
  const name = parseOptionalLocalized(object, 'name', 'CatalogueCard');
  const faceValue = optionalString(object, 'faceValue', 'CatalogueCard');
  const unitPrice = parseOptionalMoney(object, 'unitPrice');
  const businessPrice = parseOptionalMoney(object, 'businessPrice');
  const personalPrice = parseOptionalMoney(object, 'personalPrice');
  const specialOfferPrice = parseOptionalMoney(object, 'specialOfferPrice');
  const minimumQuantity = optionalInteger(object, 'minimumQuantity', 'CatalogueCard');
  const maximumQuantity = optionalInteger(object, 'maximumQuantity', 'CatalogueCard');
  return {
    id: requiredUuid(object, 'id', 'CatalogueCard'),
    subcategoryId: optionalUuid(object, 'subcategoryId', 'CatalogueCard') ?? '00000000-0000-0000-0000-000000000000',
    hasSpecialOffer: optionalBoolean(object, 'hasSpecialOffer', 'CatalogueCard') ?? false,
    available: optionalBoolean(object, 'available', 'CatalogueCard') ?? false,
    ...(name === undefined ? {} : { name }),
    ...(faceValue === undefined ? {} : { faceValue }),
    ...(unitPrice === undefined ? {} : { unitPrice }),
    ...(businessPrice === undefined ? {} : { businessPrice }),
    ...(personalPrice === undefined ? {} : { personalPrice }),
    ...(specialOfferPrice === undefined ? {} : { specialOfferPrice }),
    ...(minimumQuantity === undefined ? {} : { minimumQuantity }),
    ...(maximumQuantity === undefined ? {} : { maximumQuantity }),
  };
}

/** Parses a page and delegates each item to the route's model parser. */
export function parsePage<T>(json: unknown, parseItem: (item: unknown) => T): Page<T> {
  const object = asObject(json, 'Page');
  const items = object.items ?? [];
  if (!Array.isArray(items)) {
    throw new TypeError('Page.items must be an array.');
  }
  const nextCursor = optionalString(object, 'nextCursor', 'Page');
  return {
    items: items.map(parseItem),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

function parseOptionalLocalized(
  object: Record<string, unknown>,
  field: string,
  label: string,
): LocalizedText | undefined {
  const value = object[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  try {
    return parseLocalizedText(value);
  } catch (cause) {
    throw new TypeError(`${label}.${field} must contain Arabic or English text.`, { cause });
  }
}

function parseOptionalMoney(object: Record<string, unknown>, field: string): Money | undefined {
  const value = object[field];
  return value === undefined || value === null ? undefined : parseMoney(value);
}
