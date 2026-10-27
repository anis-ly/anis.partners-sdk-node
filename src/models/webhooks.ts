import { parseDirectRecharge, type DirectRecharge } from './direct-recharges.js';
import { parseMeterCharge, type MeterCharge } from './meter-charges.js';
import {
  asObject,
  knownValue,
  nullableInteger,
  nullableString,
  nullableTimestamp,
  optionalString,
  requiredInteger,
  requiredString,
  requiredTimestamp,
  requiredUuid,
} from './model-parsing.js';

/** Endpoint registration state. */
export type WebhookEndpointStatus = 'unknown' | 'notConfigured' | 'pendingVerification' | 'verified' | 'disabled';
/** Durable delivery state, independent of the financial outcome. */
export type WebhookDeliveryStatus =
  | 'unknown'
  | 'pending'
  | 'delivering'
  | 'delivered'
  | 'retrying'
  | 'failed'
  | 'waitingForProjection'
  | 'waitingForEndpoint'
  | 'cancelled';
/** Safe delivery failure classification. */
export type WebhookFailureKind =
  | 'unknown'
  | 'httpStatus'
  | 'timeout'
  | 'connect'
  | 'tls'
  | 'targetRefused'
  | 'responseTooLarge'
  | 'challengeMismatch'
  | 'projectionUnavailable'
  | 'endpointDisabled'
  | 'signingUnavailable';
/** Operational event types for meter charges. */
export type MeterChargeWebhookEventType = 'meterCharge.succeeded' | 'meterCharge.failed';
/** Operational event types for direct recharges. */
export type DirectRechargeWebhookEventType =
  | 'directRecharge.paid'
  | 'directRecharge.paymentFailed'
  | 'directRecharge.suspended'
  | 'directRecharge.completed'
  | 'directRecharge.rejected'
  | 'directRecharge.partiallyRefunded';
/** Known financial event discriminator; controls and future types use unknown plus rawType. */
export type WebhookEventType = MeterChargeWebhookEventType | DirectRechargeWebhookEventType | 'unknown';
/** Endpoint registration input. */
export interface SetWebhookEndpointRequest {
  /** Public HTTPS receiver URL. */ url: string;
}
/** Endpoint state; absent configuration is explicitly null. */
export interface WebhookEndpoint {
  /** Registered URL or null. */ url: string | null;
  /** Current registration state. */ status: WebhookEndpointStatus;
  /** Commands registration sequence or null. */ generation: number | null;
}
/** Queued test or redelivery acknowledgement. */
export interface WebhookEventAccepted {
  /** Event UUID. */ id: string;
  /** Queue acknowledgement state. */ status: 'pending';
  /** Queue instant. */ queuedAt: Date;
  /** Original optional type spelling, supplied on endpoint tests. */ type?: string;
}
/** Public delivery summary without payload or attempt history. */
export interface WebhookEvent {
  /** Event UUID. */ id: string;
  /** Known event discriminator or unknown. */ type: WebhookEventType;
  /** Exact wire type, including controls and future types. */ rawType: string;
  /** Current delivery state. */ status: WebhookDeliveryStatus;
  /** Actual HTTP-start count. */ attempts: number;
  /** Last HTTP-start instant or null. */ lastAttemptAt: Date | null;
  /** Next scheduled attempt instant or null. */ nextAttemptAt: Date | null;
  /** Last response status or null. */ lastResponseCode: number | null;
  /** Last safe failure kind or null. */ lastFailureKind: WebhookFailureKind | null;
}
/** Raw JSON values retained for future event data and controls. */
export type WebhookJsonValue =
  | null
  | boolean
  | number
  | string
  | WebhookJsonValue[]
  | { [key: string]: WebhookJsonValue };
/** Common verified envelope identity and event time. */
export interface WebhookEnvelopeIdentity {
  /** Durable event UUID, also the deduplication key. */ id: string;
  /** Original wire type. */ rawType: string;
  /** Triggering event instant. */ occurredAt: Date;
  /** Application UUID. */ applicationId: string;
}
/** Meter event with a complete current owner read. */
export interface MeterChargeWebhookEnvelope extends WebhookEnvelopeIdentity {
  /** Known meter event. */ type: MeterChargeWebhookEventType;
  /** Current owner state; it may be later than the event trigger. */ data: MeterCharge;
}
/** Direct recharge event with a complete current owner read. */
export interface DirectRechargeWebhookEnvelope extends WebhookEnvelopeIdentity {
  /** Known direct recharge event. */ type: DirectRechargeWebhookEventType;
  /** Current owner state; type/status equality is not required. */ data: DirectRecharge;
}
/** Future event or control whose raw JSON data is retained. */
export interface UnknownWebhookEnvelope extends WebhookEnvelopeIdentity {
  /** Controls and unrecognized operational types are not financial results. */ type: 'unknown';
  /** Raw JSON object. */ data: Record<string, WebhookJsonValue>;
}
/** Structurally validated envelope; authentication belongs to PartnerWebhookVerifier. */
export type WebhookEnvelope = MeterChargeWebhookEnvelope | DirectRechargeWebhookEnvelope | UnknownWebhookEnvelope;

const meterTypes: readonly MeterChargeWebhookEventType[] = ['meterCharge.succeeded', 'meterCharge.failed'];
const rechargeTypes: readonly DirectRechargeWebhookEventType[] = [
  'directRecharge.paid',
  'directRecharge.paymentFailed',
  'directRecharge.suspended',
  'directRecharge.completed',
  'directRecharge.rejected',
  'directRecharge.partiallyRefunded',
];

/** Parses the endpoint lifecycle leniently. */
export function parseWebhookEndpointStatus(value: unknown): WebhookEndpointStatus {
  return knownValue(value, ['notConfigured', 'pendingVerification', 'verified', 'disabled']);
}
/** Parses public delivery states leniently. */
export function parseWebhookDeliveryStatus(value: unknown): WebhookDeliveryStatus {
  return knownValue(value, [
    'pending',
    'delivering',
    'delivered',
    'retrying',
    'failed',
    'waitingForProjection',
    'waitingForEndpoint',
    'cancelled',
  ]);
}
/** Parses safe delivery failure kinds leniently. */
export function parseWebhookFailureKind(value: unknown): WebhookFailureKind {
  return knownValue(value, [
    'httpStatus',
    'timeout',
    'connect',
    'tls',
    'targetRefused',
    'responseTooLarge',
    'challengeMismatch',
    'projectionUnavailable',
    'endpointDisabled',
    'signingUnavailable',
  ]);
}
/** Matches explicit operational spellings; raw control/future types are retained separately. */
export function parseWebhookEventType(value: unknown): WebhookEventType {
  return knownValue(value, [...meterTypes, ...rechargeTypes]);
}
/** Preserves the required null URL and generation members. */
export function parseWebhookEndpoint(value: unknown): WebhookEndpoint {
  const o = asObject(value, 'WebhookEndpoint');
  return {
    url: nullableString(o, 'url', 'WebhookEndpoint'),
    status: parseWebhookEndpointStatus(requiredString(o, 'status', 'WebhookEndpoint')),
    generation: nullableInteger(o, 'generation', 'WebhookEndpoint'),
  };
}
/** Parses the queued acknowledgement without inventing a Location. */
export function parseWebhookEventAccepted(value: unknown): WebhookEventAccepted {
  const o = asObject(value, 'WebhookEventAccepted');
  if (o.status !== 'pending') throw new TypeError('WebhookEventAccepted.status must be pending.');
  const type = optionalString(o, 'type', 'WebhookEventAccepted');
  return {
    id: requiredUuid(o, 'id', 'WebhookEventAccepted'),
    status: 'pending',
    queuedAt: requiredTimestamp(o, 'queuedAt', 'WebhookEventAccepted'),
    ...(type === undefined ? {} : { type }),
  };
}
/** Parses the summary with every required nullable member retained. */
export function parseWebhookEvent(value: unknown): WebhookEvent {
  const o = asObject(value, 'WebhookEvent');
  const rawType = requiredString(o, 'type', 'WebhookEvent');
  const failure = nullableString(o, 'lastFailureKind', 'WebhookEvent');
  return {
    id: requiredUuid(o, 'id', 'WebhookEvent'),
    type: parseWebhookEventType(rawType),
    rawType,
    status: parseWebhookDeliveryStatus(requiredString(o, 'status', 'WebhookEvent')),
    attempts: requiredInteger(o, 'attempts', 'WebhookEvent'),
    lastAttemptAt: nullableTimestamp(o, 'lastAttemptAt', 'WebhookEvent'),
    nextAttemptAt: nullableTimestamp(o, 'nextAttemptAt', 'WebhookEvent'),
    lastResponseCode: nullableInteger(o, 'lastResponseCode', 'WebhookEvent'),
    lastFailureKind: failure === null ? null : parseWebhookFailureKind(failure),
  };
}
/**
 * Validates envelope structure and parses known financial data strictly. This does not authenticate a webhook;
 * call verifyAndParse on PartnerWebhookVerifier before acting on network input.
 */
export function parseWebhookEnvelope(value: unknown): WebhookEnvelope {
  const o = asObject(value, 'WebhookEnvelope');
  const rawType = requiredString(o, 'type', 'WebhookEnvelope');
  const common = {
    id: requiredUuid(o, 'id', 'WebhookEnvelope'),
    rawType,
    occurredAt: requiredTimestamp(o, 'occurredAt', 'WebhookEnvelope'),
    applicationId: requiredUuid(o, 'applicationId', 'WebhookEnvelope'),
  };
  const meterType = meterTypes.find((type) => type === rawType);
  if (meterType !== undefined) return { ...common, type: meterType, data: parseMeterCharge(o.data) };
  const rechargeType = rechargeTypes.find((type) => type === rawType);
  if (rechargeType !== undefined) return { ...common, type: rechargeType, data: parseDirectRecharge(o.data) };
  const data = asObject(o.data, 'WebhookEnvelope.data');
  return { ...common, type: 'unknown', data: parseJsonObject(data) };
}
function parseJsonObject(value: Record<string, unknown>): Record<string, WebhookJsonValue> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, parseJsonValue(entry)]));
}
function parseJsonValue(value: unknown): WebhookJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(parseJsonValue);
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return parseJsonObject(asObject(value, 'WebhookEnvelope.data'));
  throw new TypeError('WebhookEnvelope.data must contain JSON values.');
}
