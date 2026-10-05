import { asObject, optionalString, requiredUuid } from './model-parsing.js';
import { parseMoney, type Money } from './money.js';

/**
 * A wallet this application may act on after current access and owner rules are applied.
 *
 * @remarks The API has already intersected the application's grants with live owner and subscription eligibility;
 * absent subscription and capability fields are not independent permissions for partners to infer.
 */
export interface Wallet {
  /** Wallet identity used by calls on this wallet. */
  id: string;
  /** Display name when the owner supplied one. */
  name?: string;
  /** Currency code used by its balances and orders. */
  currency?: string;
  /** Reserved-adjusted balance and the instant at which it was computed. */
  balance: Money;
}

/**
 * The application's identity and the scopes its current policy grants.
 *
 * @remarks Names and environment are omitted because deployments are isolated copies; exposing a single-valued
 * environment would invite branching that cannot change the API surface.
 */
export interface PartnerProfile {
  /** The Partner identity; names are intentionally not part of this surface. */
  partner?: PartnerIdentity;
  /** This application and its effective permissions. */
  application?: ApplicationIdentity;
  /** The owner account behind the wallets, when exposed by the surface. */
  ownerAccount?: OwnerAccount;
  /** Documentation version this deployment is aligned with. */
  documentationVersion?: string;
}

/** Partner identity, by canonical UUID. */
export interface PartnerIdentity {
  /** Partner UUID in lower-case hyphenated form. */
  id: string;
}

/**
 * Application identity and its effective scopes.
 *
 * @remarks The application id remains stable while signing keys rotate, and scopes should be read from each response
 * because policy can change between calls.
 */
export interface ApplicationIdentity {
  /** Stable application identity; keys can rotate beneath it. */
  id: string;
  /** Scopes in force for calls made now; policy can change between calls. */
  scopes: readonly string[];
}

/** Owner account identity behind the wallets. */
export interface OwnerAccount {
  /** Owner account UUID in lower-case hyphenated form. */
  id: string;
  /** Display name when the owner supplied one. */
  displayName?: string;
}

/** Parses a wallet while preserving optional members as optional. */
export function parseWallet(json: unknown): Wallet {
  const object = asObject(json, 'Wallet');
  const name = optionalString(object, 'name', 'Wallet');
  const currency = optionalString(object, 'currency', 'Wallet');
  return {
    id: requiredUuid(object, 'id', 'Wallet'),
    balance: parseMoney(object.balance),
    ...(name === undefined ? {} : { name }),
    ...(currency === undefined ? {} : { currency }),
  };
}

/** Parses the application identity response. */
export function parsePartnerProfile(json: unknown): PartnerProfile {
  const object = asObject(json, 'PartnerProfile');
  const partner =
    object.partner === undefined || object.partner === null ? undefined : parsePartnerIdentity(object.partner);
  const application =
    object.application === undefined || object.application === null
      ? undefined
      : parseApplicationIdentity(object.application);
  const ownerAccount =
    object.ownerAccount === undefined || object.ownerAccount === null
      ? undefined
      : parseOwnerAccount(object.ownerAccount);
  const documentationVersion = optionalString(object, 'documentationVersion', 'PartnerProfile');
  return {
    ...(partner === undefined ? {} : { partner }),
    ...(application === undefined ? {} : { application }),
    ...(ownerAccount === undefined ? {} : { ownerAccount }),
    ...(documentationVersion === undefined ? {} : { documentationVersion }),
  };
}

/** Parses a partner identity. */
export function parsePartnerIdentity(json: unknown): PartnerIdentity {
  const object = asObject(json, 'PartnerIdentity');
  return { id: requiredUuid(object, 'id', 'PartnerIdentity') };
}

/** Parses an application identity and validates all supplied scopes. */
export function parseApplicationIdentity(json: unknown): ApplicationIdentity {
  const object = asObject(json, 'ApplicationIdentity');
  const scopes = object.scopes ?? [];
  if (!Array.isArray(scopes) || !scopes.every((scope): scope is string => typeof scope === 'string')) {
    throw new TypeError('ApplicationIdentity.scopes must be an array of strings.');
  }
  return { id: requiredUuid(object, 'id', 'ApplicationIdentity'), scopes };
}

/** Parses an owner account identity. */
export function parseOwnerAccount(json: unknown): OwnerAccount {
  const object = asObject(json, 'OwnerAccount');
  const displayName = optionalString(object, 'displayName', 'OwnerAccount');
  return {
    id: requiredUuid(object, 'id', 'OwnerAccount'),
    ...(displayName === undefined ? {} : { displayName }),
  };
}
