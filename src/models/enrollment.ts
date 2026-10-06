import {
  asObject,
  optionalInteger,
  optionalString,
  optionalTimestamp,
  optionalUuid,
  requiredUuid,
} from './model-parsing.js';
import type { PartnerJwk } from '../verification/partner-jwk.js';

/** Invitation state as reported by the enrollment surface. */
export interface EnrollmentState {
  /** Invitation UUID, when known. */
  invitationId?: string;
  /** Application UUID being enrolled. */
  applicationId?: string;
  /** Current invitation workflow state. */
  state?: string;
  /** Invitation expiry instant. */
  expiresAt?: Date;
}

/**
 * Public key and requested validity window submitted during enrollment.
 *
 * @remarks Submit only the public half: sending private key material is refused by Anis and would expose signing
 * credentials outside the partner's key custody.
 */
export interface EnrollmentKeyRequest {
  /** Public P-256 JWK only; private members are refused by Anis. */
  publicJwk: PartnerJwk;
  /** Requested beginning of the validity window. */
  notBefore: Date;
  /** Requested end of the validity window. */
  expiresAt: Date;
}

/**
 * Key submission answer containing the challenge that must be signed.
 *
 * @remarks The local thumbprint check ties Anis's challenge and safety code to the key the partner actually submitted;
 * do not trust a safety code copied from an unverified answer.
 */
export interface EnrollmentKeyResult {
  /** Credential UUID that becomes the request key id when active. */
  keyId: string;
  /** Server-computed RFC 7638 thumbprint, compared against the submitted public key. */
  thumbprint?: string;
  /** Safety code derived locally from the verified key thumbprint. */
  safetyCode?: string;
  /** Challenge whose domain-separated message proves possession of the private key. */
  challenge?: string;
  /** Challenge generation, incremented when Anis reissues the challenge. */
  challengeGeneration?: number;
}

/** Proof request for the current enrollment challenge generation. */
export interface EnrollmentProofRequest {
  /** Credential UUID whose challenge is being answered. */
  keyId: string;
  /** Generation that Anis currently expects. */
  challengeGeneration: number;
  /** P-256/P1363 signature in unpadded base64url form. */
  signature: string;
}

/**
 * Enrollment proof and staff-approval state.
 *
 * @remarks A successful proof can remain pending until Anis staff verify the safety code. That approval is a control
 * on activation, not a state to work around.
 */
export interface EnrollmentStatus {
  /** Credential UUID, when the invitation has accepted a key. */
  keyId?: string;
  /** Current challenge generation. */
  challengeGeneration?: number;
  /** Proof workflow state. */
  proofState?: string;
  /** Staff approval state. */
  approvalState?: string;
  /** Overall enrollment state. */
  state?: string;
  /** Current workflow-step expiry instant. */
  expiresAt?: Date;
  /** Credential validity end instant after activation. */
  keyExpiresAt?: Date;
}

/** Facts the signature self-check reports about how the gateway interpreted a request. */
export interface SignatureDiagnostic {
  /** Matched route identifier. */
  routeId?: string;
  /** HTTP method received by the gateway. */
  method?: string;
  /** Authority received by the gateway. */
  authority?: string;
  /** Path received by the gateway. */
  path?: string;
  /** Query without its leading question mark. */
  canonicalQuery?: string;
  /** Kind assigned by the route table. */
  requestKind?: string;
  /** Required permission for the route. */
  requiredScope?: string;
  /** Covered components required by the matched profile. */
  coveredComponents: readonly string[];
  /** Credential UUID named by the request. */
  keyId?: string;
  /** Partner UUID resolved from that credential. */
  partnerId?: string;
  /** Application UUID resolved from that credential. */
  applicationId?: string;
  /** Policy version applied. */
  policyVersion?: number;
  /** Scopes currently in effect. */
  effectiveScopes: readonly string[];
  /** Instant the gateway received the request. */
  receivedAt?: Date;
}

/** Parses an enrollment invitation state. */
export function parseEnrollmentState(json: unknown): EnrollmentState {
  const object = asObject(json, 'EnrollmentState');
  const invitationId = optionalUuid(object, 'invitationId', 'EnrollmentState');
  const applicationId = optionalUuid(object, 'applicationId', 'EnrollmentState');
  const state = optionalString(object, 'state', 'EnrollmentState');
  const expiresAt = optionalTimestamp(object, 'expiresAt', 'EnrollmentState');
  return {
    ...(invitationId === undefined ? {} : { invitationId }),
    ...(applicationId === undefined ? {} : { applicationId }),
    ...(state === undefined ? {} : { state }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

/** Parses a key submission challenge answer. */
export function parseEnrollmentKeyResult(json: unknown): EnrollmentKeyResult {
  const object = asObject(json, 'EnrollmentKeyResult');
  const keyId = requiredUuid(object, 'keyId', 'EnrollmentKeyResult');
  const thumbprint = optionalString(object, 'thumbprint', 'EnrollmentKeyResult');
  const safetyCode = optionalString(object, 'safetyCode', 'EnrollmentKeyResult');
  const challenge = optionalString(object, 'challenge', 'EnrollmentKeyResult');
  const challengeGeneration = optionalInteger(object, 'challengeGeneration', 'EnrollmentKeyResult');
  return {
    keyId,
    ...(thumbprint === undefined ? {} : { thumbprint }),
    ...(safetyCode === undefined ? {} : { safetyCode }),
    ...(challenge === undefined ? {} : { challenge }),
    ...(challengeGeneration === undefined ? {} : { challengeGeneration }),
  };
}

/** Parses an enrollment status while keeping newly optional dates absent. */
export function parseEnrollmentStatus(json: unknown): EnrollmentStatus {
  const object = asObject(json, 'EnrollmentStatus');
  const keyId = optionalUuid(object, 'keyId', 'EnrollmentStatus');
  const challengeGeneration = optionalInteger(object, 'challengeGeneration', 'EnrollmentStatus');
  const proofState = optionalString(object, 'proofState', 'EnrollmentStatus');
  const approvalState = optionalString(object, 'approvalState', 'EnrollmentStatus');
  const state = optionalString(object, 'state', 'EnrollmentStatus');
  const expiresAt = optionalTimestamp(object, 'expiresAt', 'EnrollmentStatus');
  const keyExpiresAt = optionalTimestamp(object, 'keyExpiresAt', 'EnrollmentStatus');
  return {
    ...(keyId === undefined ? {} : { keyId }),
    ...(challengeGeneration === undefined ? {} : { challengeGeneration }),
    ...(proofState === undefined ? {} : { proofState }),
    ...(approvalState === undefined ? {} : { approvalState }),
    ...(state === undefined ? {} : { state }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(keyExpiresAt === undefined ? {} : { keyExpiresAt }),
  };
}

/** Parses diagnostic facts and defaults missing collections to empty arrays for straightforward partner checks. */
export function parseSignatureDiagnostic(json: unknown): SignatureDiagnostic {
  const object = asObject(json, 'SignatureDiagnostic');
  const routeId = optionalString(object, 'routeId', 'SignatureDiagnostic');
  const method = optionalString(object, 'method', 'SignatureDiagnostic');
  const authority = optionalString(object, 'authority', 'SignatureDiagnostic');
  const path = optionalString(object, 'path', 'SignatureDiagnostic');
  const canonicalQuery = optionalString(object, 'canonicalQuery', 'SignatureDiagnostic');
  const requestKind = optionalString(object, 'requestKind', 'SignatureDiagnostic');
  const requiredScope = optionalString(object, 'requiredScope', 'SignatureDiagnostic');
  const coveredComponents = stringArray(object.coveredComponents, 'SignatureDiagnostic.coveredComponents');
  const keyId = optionalUuid(object, 'keyId', 'SignatureDiagnostic');
  const partnerId = optionalUuid(object, 'partnerId', 'SignatureDiagnostic');
  const applicationId = optionalUuid(object, 'applicationId', 'SignatureDiagnostic');
  const policyVersion = optionalInteger(object, 'policyVersion', 'SignatureDiagnostic');
  const effectiveScopes = stringArray(object.effectiveScopes, 'SignatureDiagnostic.effectiveScopes');
  const receivedAt = optionalTimestamp(object, 'receivedAt', 'SignatureDiagnostic');
  return {
    coveredComponents,
    effectiveScopes,
    ...(routeId === undefined ? {} : { routeId }),
    ...(method === undefined ? {} : { method }),
    ...(authority === undefined ? {} : { authority }),
    ...(path === undefined ? {} : { path }),
    ...(canonicalQuery === undefined ? {} : { canonicalQuery }),
    ...(requestKind === undefined ? {} : { requestKind }),
    ...(requiredScope === undefined ? {} : { requiredScope }),
    ...(keyId === undefined ? {} : { keyId }),
    ...(partnerId === undefined ? {} : { partnerId }),
    ...(applicationId === undefined ? {} : { applicationId }),
    ...(policyVersion === undefined ? {} : { policyVersion }),
    ...(receivedAt === undefined ? {} : { receivedAt }),
  };
}

function stringArray(value: unknown, label: string): readonly string[] {
  const items = value ?? [];
  if (!Array.isArray(items) || !items.every((item): item is string => typeof item === 'string')) {
    throw new TypeError(`${label} must be an array of strings.`);
  }
  return items;
}
