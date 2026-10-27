import * as uuidModule from '../internal/uuid.js';

/** Shared runtime checks used by the wire model parsers. */
export type JsonObject = Record<string, unknown>;

/** Requires an object so malformed JSON cannot silently become a partially empty model. */
export function asObject(value: unknown, label: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object.`);
  }
  return value as JsonObject;
}

/** Reads a required string field. */
export function requiredString(object: JsonObject, field: string, label: string): string {
  const value = object[field];
  if (typeof value !== 'string') {
    throw new TypeError(`${label}.${field} must be a string.`);
  }
  return value;
}

/** Reads an optional string field; a missing or null member stays absent. */
export function optionalString(object: JsonObject, field: string, label: string): string | undefined {
  const value = object[field];
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new TypeError(`${label}.${field} must be a string when present.`);
  }
  return value;
}

/** Reads a required canonical UUID field. */
export function requiredUuid(object: JsonObject, field: string, label: string): string {
  const { canonicalUuid } = uuidModule;
  return canonicalUuid(requiredString(object, field, label), `${label}.${field}`);
}

/** Reads an optional UUID field. */
export function optionalUuid(object: JsonObject, field: string, label: string): string | undefined {
  const value = optionalString(object, field, label);
  return value === undefined ? undefined : uuidModule.canonicalUuid(value, `${label}.${field}`);
}

/** Reads an optional timestamp as a valid Date. */
export function optionalTimestamp(object: JsonObject, field: string, label: string): Date | undefined {
  const value = optionalString(object, field, label);
  if (value === undefined) {
    return undefined;
  }
  const result = new Date(value);
  if (!isStrictIsoTimestamp(value) || Number.isNaN(result.getTime())) {
    throw new TypeError(`${label}.${field} must be a valid timestamp.`);
  }
  return result;
}

function isStrictIsoTimestamp(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
      value,
    );
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth;
}

/** Reads an optional integer field. */
export function optionalInteger(object: JsonObject, field: string, label: string): number | undefined {
  const value = object[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TypeError(`${label}.${field} must be an integer when present.`);
  }
  return value;
}

/** Reads an optional boolean field. */
export function optionalBoolean(object: JsonObject, field: string, label: string): boolean | undefined {
  const value = object[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new TypeError(`${label}.${field} must be a boolean when present.`);
  }
  return value;
}

/** Reads a required valid timestamp without inventing a missing time. */
export function requiredTimestamp(object: JsonObject, field: string, label: string): Date {
  const value = optionalTimestamp(object, field, label);
  if (value === undefined) throw new TypeError(`${label}.${field} is required.`);
  return value;
}

/** Reads a required integer. */
export function requiredInteger(object: JsonObject, field: string, label: string): number {
  const value = optionalInteger(object, field, label);
  if (value === undefined) throw new TypeError(`${label}.${field} is required.`);
  return value;
}

/** Reads a required boolean. */
export function requiredBoolean(object: JsonObject, field: string, label: string): boolean {
  const value = optionalBoolean(object, field, label);
  if (value === undefined) throw new TypeError(`${label}.${field} is required.`);
  return value;
}

/** Parses every member of a required array. */
export function requiredArray<T>(object: JsonObject, field: string, label: string, parse: (value: unknown) => T): T[] {
  const value = object[field];
  if (!Array.isArray(value)) throw new TypeError(`${label}.${field} must be an array.`);
  return value.map(parse);
}

/** Parses an optional nested value without filling absent members. */
export function optionalParsed<T>(value: unknown, parse: (value: unknown) => T): T | undefined {
  return value === undefined || value === null ? undefined : parse(value);
}

/** Matches only published spellings, keeping future values unresolved. */
export function knownValue<T extends string>(value: unknown, known: readonly T[]): T | 'unknown' {
  return known.find((entry) => entry === value) ?? 'unknown';
}

/** Reads a required string-or-null member, preserving explicit nulls. */
export function nullableString(object: JsonObject, field: string, label: string): string | null {
  return object[field] === null ? null : requiredString(object, field, label);
}

/** Reads a required integer-or-null member, preserving explicit nulls. */
export function nullableInteger(object: JsonObject, field: string, label: string): number | null {
  return object[field] === null ? null : requiredInteger(object, field, label);
}

/** Reads a required timestamp-or-null member, preserving explicit nulls. */
export function nullableTimestamp(object: JsonObject, field: string, label: string): Date | null {
  return object[field] === null ? null : requiredTimestamp(object, field, label);
}

/** Validates the three-member product acknowledgement independently of full reads. */
export function parseProductAccepted<T extends 'meterCharge' | 'directRecharge'>(
  value: unknown,
  operationType: T,
): {
  operationId: string;
  operationType: T;
  status: 'processing';
} {
  const object = asObject(value, 'ProductAccepted');
  if (Object.keys(object).length !== 3 || object.operationType !== operationType || object.status !== 'processing')
    throw new TypeError('Invalid product processing acknowledgement.');
  return { operationId: requiredUuid(object, 'operationId', 'ProductAccepted'), operationType, status: 'processing' };
}
