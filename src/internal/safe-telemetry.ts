import { metrics, SpanKind, trace, type Span, type SpanOptions } from '@opentelemetry/api';
import type { PartnerLogger } from '../observability/logger.js';

const scope = '@anis-ly/partners';

/** Runs the business callback even when a host tracing provider throws before creating a span. */
export async function withSafeSpan<T>(name: string, action: (span: Span | undefined) => Promise<T>): Promise<T> {
  let callbackResult: Promise<T> | undefined;
  try {
    const tracer = trace.getTracer(scope);
    const result = tracer.startActiveSpan(name, { kind: SpanKind.CLIENT } satisfies SpanOptions, (span) => {
      callbackResult = Promise.resolve().then(() => action(span));
      return callbackResult;
    });
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
    logger[level]?.(message, fields);
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
    metrics.getMeter(scope).createHistogram(name, options).record(value, attributes);
  } catch {
    // Host instrumentation is diagnostic only.
  }
}

/** Increments a counter without allowing a host meter to affect a business result. */
export function safeCounter(name: string, attributes: Record<string, string | number | boolean>): void {
  try {
    metrics.getMeter(scope).createCounter(name).add(1, attributes);
  } catch {
    // Host instrumentation is diagnostic only.
  }
}
