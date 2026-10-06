import {
  metrics,
  SpanKind,
  trace,
  type Counter,
  type Histogram,
  type Meter,
  type Span,
  type SpanOptions,
} from '@opentelemetry/api';
import type { PartnerLogger } from '../observability/logger.js';
import { AnisPartnersTelemetry } from '../observability/telemetry-names.js';

const packageVersion = '1.0.0';
const histograms = new WeakMap<Meter, Map<string, Histogram>>();
const counters = new WeakMap<Meter, Map<string, Counter>>();

/** Runs the business callback even when a host tracing provider throws before creating a span. */
export async function withSafeSpan<T>(name: string, action: (span: Span | undefined) => Promise<T>): Promise<T> {
  let callbackResult: Promise<T> | undefined;
  try {
    const tracer = trace.getTracer(AnisPartnersTelemetry.scope, packageVersion);
    const result = tracer.startActiveSpan(name, { kind: SpanKind.CLIENT } satisfies SpanOptions, (span) => {
      callbackResult = Promise.resolve().then(() => action(span));
      return callbackResult;
    });
    void Promise.resolve(result).catch(() => undefined);
    if (callbackResult !== undefined) return await callbackResult;
    await result;
  } catch {
    if (callbackResult !== undefined) return callbackResult;
  }
  return action(undefined);
}

/** Swallows host span failures so instrumentation cannot change the API result. */
export function safeSpan(span: Span | undefined, action: (span: Span) => void): void {
  if (span === undefined) return;
  try {
    action(span);
  } catch {
    // Host instrumentation is diagnostic only.
  }
}

/** Sends a structured message without allowing a host logger to affect a business result. */
export function safeLog(
  logger: Partial<PartnerLogger> | undefined,
  level: keyof PartnerLogger,
  message: string,
  fields: Record<string, unknown>,
): void {
  if (logger === undefined) return;
  try {
    const result = logger[level]?.(message, fields);
    if (result !== undefined && typeof (result as PromiseLike<unknown>).then === 'function') {
      void Promise.resolve(result).catch(() => undefined);
    }
  } catch {
    // Host instrumentation is diagnostic only.
  }
}

/** Records a histogram value without allowing a host meter to affect a business result. */
export function safeHistogram(
  name: string,
  value: number,
  attributes: Record<string, string | number | boolean>,
  options?: { unit?: string },
): void {
  try {
    const meter = metrics.getMeter(AnisPartnersTelemetry.scope, packageVersion);
    const instruments = instrumentsFor(histograms, meter);
    let instrument = instruments.get(name);
    if (instrument === undefined) {
      instrument = meter.createHistogram(name, { ...options, description: `${name} for signed Partner API calls` });
      instruments.set(name, instrument);
    }
    instrument.record(value, attributes);
  } catch {
    // Host instrumentation is diagnostic only.
  }
}

/** Increments a counter without allowing a host meter to affect a business result. */
export function safeCounter(name: string, attributes: Record<string, string | number | boolean>): void {
  try {
    const meter = metrics.getMeter(AnisPartnersTelemetry.scope, packageVersion);
    const instruments = instrumentsFor(counters, meter);
    let instrument = instruments.get(name);
    if (instrument === undefined) {
      instrument = meter.createCounter(name, { description: `${name} for signed Partner API calls` });
      instruments.set(name, instrument);
    }
    instrument.add(1, attributes);
  } catch {
    // Host instrumentation is diagnostic only.
  }
}

function instrumentsFor<T>(cache: WeakMap<Meter, Map<string, T>>, meter: Meter): Map<string, T> {
  let instruments = cache.get(meter);
  if (instruments === undefined) {
    instruments = new Map<string, T>();
    cache.set(meter, instruments);
  }
  return instruments;
}
