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
  if (value === undefined || value === null) {
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
  return canonicalUuid(requiredString(object, field, label));
}

/** Reads an optional UUID field. */
export function optionalUuid(object: JsonObject, field: string, label: string): string | undefined {
  const value = optionalString(object, field, label);
  return value === undefined ? undefined : uuidModule.canonicalUuid(value);
}

/** Reads an optional timestamp as a valid Date. */
export function optionalTimestamp(object: JsonObject, field: string, label: string): Date | undefined {
  const value = optionalString(object, field, label);
  if (value === undefined) {
    return undefined;
  }
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) {
    throw new TypeError(`${label}.${field} must be a valid timestamp.`);
  }
  return result;
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
