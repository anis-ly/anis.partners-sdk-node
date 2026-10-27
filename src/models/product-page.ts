import { parsePage } from './catalogue.js';
import { asObject } from './model-parsing.js';

/** A product page preserves the server's explicit terminal null cursor. */
export interface ProductPage<T> {
  /** Values on this page. */
  items: readonly T[];
  /** Opaque continuation; null or absence terminates iteration. */
  nextCursor?: string | null;
}

/** Parses new product pages without changing the existing catalogue page contract. */
export function parseProductPage<T>(json: unknown, parseItem: (item: unknown) => T): ProductPage<T> {
  const object = asObject(json, 'ProductPage');
  const page = parsePage(json, parseItem);
  return object.nextCursor === null ? { ...page, nextCursor: null } : page;
}
