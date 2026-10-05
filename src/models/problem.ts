import { asObject, optionalInteger, optionalString } from './model-parsing.js';

/** RFC 9457 problem returned for a verified refusal. Branch on code, never localized title or detail. */
export interface Problem {
  /** Permanent documentation URI for this error. */
  type?: string;
  /** Localized presentation text. */
  title?: string;
  /** HTTP status repeated in the body. */
  status: number;
  /** Localized presentation detail. */
  detail?: string;
  /** Machine code used for stable decisions. */
  code?: string;
  /** Correlation id to quote when asking Anis about this call. */
  requestId?: string;
  /** Documented per-code extensions retained without assuming their shape. */
  extensions?: unknown;
}

/** Parses a problem while retaining only documented RFC and SDK members. */
export function parseProblem(json: unknown): Problem {
  const object = asObject(json, 'Problem');
  const type = optionalString(object, 'type', 'Problem');
  const title = optionalString(object, 'title', 'Problem');
  const detail = optionalString(object, 'detail', 'Problem');
  const code = optionalString(object, 'code', 'Problem');
  const requestId = optionalString(object, 'requestId', 'Problem');
  const status = optionalInteger(object, 'status', 'Problem') ?? 0;
  const extensions = object.extensions;
  return {
    status,
    ...(type === undefined ? {} : { type }),
    ...(title === undefined ? {} : { title }),
    ...(detail === undefined ? {} : { detail }),
    ...(code === undefined ? {} : { code }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(extensions === undefined || extensions === null ? {} : { extensions }),
  };
}
