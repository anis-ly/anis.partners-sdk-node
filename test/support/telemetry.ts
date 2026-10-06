import { metrics, trace, SpanStatusCode } from '@opentelemetry/api';
import type { Meter, MeterProvider } from '@opentelemetry/api';
import type {
  BatchObservableCallback,
  Counter,
  Gauge,
  Histogram,
  Attributes,
  MetricOptions,
  Observable,
  ObservableCallback,
  ObservableCounter,
  ObservableGauge,
  ObservableUpDownCounter,
  UpDownCounter,
} from '@opentelemetry/api';
import type {
  AttributeValue,
  Span,
  SpanContext,
  SpanOptions,
  SpanStatus,
  Tracer,
  TracerOptions,
  TracerProvider,
} from '@opentelemetry/api';
import type { Context } from '@opentelemetry/api';

/** Recorded OTel measurement from the no-SDK test provider. */
export interface CapturedMeasurement {
  /** Instrument name created by the package. */
  instrument: string;
  /** Recorded value. */
  value: number;
  /** Attributes attached by the package. */
  attributes: Attributes;
}

/** OTel span captured without depending on an OpenTelemetry SDK package. */
export class CapturedSpan implements Span {
  /** Instrumentation span name. */
  name = '';
  /** Attributes recorded on this span. */
  readonly attributes: Record<string, unknown> = {};
  readonly events: string[] = [];
  options: SpanOptions | undefined = undefined;
  parentContext: Context | undefined = undefined;
  /** Final status recorded on this span. */
  status: SpanStatus = { code: SpanStatusCode.UNSET };
  /** True once the SDK ends the span. */
  ended = false;

  spanContext(): SpanContext {
    return { traceId: '0123456789abcdef0123456789abcdef', spanId: '0123456789abcdef', traceFlags: 1 };
  }
  setAttribute(key: string, value: AttributeValue): this {
    this.attributes[key] = value;
    return this;
  }
  setAttributes(attributes: Attributes): this {
    Object.assign(this.attributes, attributes);
    return this;
  }
  addEvent(name: string): this {
    this.events.push(name);
    return this;
  }
  addLink(link: { context: SpanContext }): this {
    this.events.push(link.context.traceId);
    return this;
  }
  addLinks(links: { context: SpanContext }[]): this {
    this.events.push(...links.map((link) => link.context.traceId));
    return this;
  }
  setStatus(status: SpanStatus): this {
    this.status = status;
    return this;
  }
  updateName(name: string): this {
    this.name = name;
    return this;
  }
  end(): void {
    this.ended = true;
  }
  isRecording(): boolean {
    return !this.ended;
  }
  recordException(exception: Error | string): void {
    this.events.push(exception instanceof Error ? exception.name : exception);
  }
}

/** Small in-memory implementation of the OpenTelemetry API used to assert SDK signals without an SDK dependency. */
export class InMemoryTelemetry implements TracerProvider, MeterProvider {
  /** Captured spans from SDK calls. */
  readonly spans: CapturedSpan[] = [];
  /** Captured counter and histogram measurements. */
  readonly measurements: CapturedMeasurement[] = [];
  private readonly instruments = new Map<string, MemoryInstrument>();
  readonly scopes: string[] = [];
  rejectWrappedSpanResult = false;
  failSpanStart = false;
  failMeasurements = false;

  /** Registers this API implementation with the global OTel proxies used by the SDK. */
  constructor() {
    trace.setGlobalTracerProvider(this);
    metrics.setGlobalMeterProvider(this);
  }

  getTracer(name: string, version?: string, options?: TracerOptions): Tracer {
    this.scopes.push(`trace:${name}:${version ?? ''}:${options?.schemaUrl ?? ''}`);
    return new MemoryTracer(this.spans, this);
  }

  getMeter(name: string): Meter {
    this.scopes.push(`metrics:${name}`);
    return new MemoryMeter(this.instruments, this.measurements, this);
  }
}

class MemoryTracer implements Tracer {
  constructor(
    private readonly spans: CapturedSpan[],
    private readonly telemetry: InMemoryTelemetry,
  ) {}

  startSpan(name: string, options?: SpanOptions, context?: Context): Span {
    const span = new CapturedSpan();
    span.name = name;
    span.options = options;
    span.parentContext = context;
    this.spans.push(span);
    return span;
  }

  startActiveSpan<F extends (span: Span) => unknown>(name: string, fn: F): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(name: string, options: SpanOptions, fn: F): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    options: SpanOptions,
    context: Context,
    fn: F,
  ): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    optionsOrFn: SpanOptions | F,
    contextOrFn?: Context | F,
    finalFn?: F,
  ): ReturnType<F> {
    if (this.telemetry.failSpanStart) throw new Error('test tracer failure');
    const callback = typeof optionsOrFn === 'function' ? optionsOrFn : (finalFn ?? (contextOrFn as F));
    callback(this.startSpan(name));
    if (this.telemetry.rejectWrappedSpanResult)
      return Promise.reject(new Error('tracer wrapper failed')) as ReturnType<F>;
    return undefined as ReturnType<F>;
  }
}

class MemoryInstrument {
  constructor(
    private readonly instrument: string,
    private readonly measurements: CapturedMeasurement[],
    private readonly telemetry: InMemoryTelemetry,
  ) {}
  add(value: number, attributes?: Attributes): void {
    if (this.telemetry.failMeasurements) throw new Error('test meter failure');
    this.record(value, attributes);
  }
  record(value: number, attributes?: Attributes): void {
    if (this.telemetry.failMeasurements) throw new Error('test meter failure');
    this.measurements.push({ instrument: this.instrument, value, attributes: attributes ?? {} });
  }
}

class MemoryMeter implements Meter {
  constructor(
    private readonly instruments: Map<string, MemoryInstrument>,
    private readonly measurements: CapturedMeasurement[],
    private readonly telemetry: InMemoryTelemetry,
  ) {}
  private readonly instrumentOptions = new Map<string, MetricOptions>();
  private readonly batchCallbacks: BatchObservableCallback[] = [];
  private readonly observableSets = new Set<Observable>();

  createGauge<A extends Attributes = Attributes>(name: string, options?: MetricOptions): Gauge<A> {
    return this.instrument(name, options);
  }
  createHistogram<A extends Attributes = Attributes>(name: string, options?: MetricOptions): Histogram<A> {
    return this.instrument(name, options);
  }
  createCounter<A extends Attributes = Attributes>(name: string, options?: MetricOptions): Counter<A> {
    return this.instrument(name, options);
  }
  createUpDownCounter<A extends Attributes = Attributes>(name: string, options?: MetricOptions): UpDownCounter<A> {
    return this.instrument(name, options);
  }
  createObservableGauge<A extends Attributes = Attributes>(name: string, options?: MetricOptions): ObservableGauge<A> {
    this.instrumentOptions.set(name, options ?? {});
    return new MemoryObservable<A>();
  }
  createObservableCounter<A extends Attributes = Attributes>(
    name: string,
    options?: MetricOptions,
  ): ObservableCounter<A> {
    this.instrumentOptions.set(name, options ?? {});
    return new MemoryObservable<A>();
  }
  createObservableUpDownCounter<A extends Attributes = Attributes>(
    name: string,
    options?: MetricOptions,
  ): ObservableUpDownCounter<A> {
    this.instrumentOptions.set(name, options ?? {});
    return new MemoryObservable<A>();
  }
  addBatchObservableCallback<A extends Attributes = Attributes>(
    callback: BatchObservableCallback<A>,
    observables: Observable<A>[],
  ): void {
    this.batchCallbacks.push(callback);
    observables.forEach((observable) => this.observableSets.add(observable));
  }
  removeBatchObservableCallback<A extends Attributes = Attributes>(
    callback: BatchObservableCallback<A>,
    observables: Observable<A>[],
  ): void {
    this.batchCallbacks.splice(this.batchCallbacks.indexOf(callback), 1);
    observables.forEach((observable) => this.observableSets.delete(observable));
  }

  private instrument(name: string, options?: MetricOptions): MemoryInstrument {
    const found = this.instruments.get(name);
    if (found !== undefined) return found;
    const created = new MemoryInstrument(name, this.measurements, this.telemetry);
    this.instrumentOptions.set(name, options ?? {});
    this.instruments.set(name, created);
    return created;
  }
}

class MemoryObservable<A extends Attributes> implements Observable<A> {
  private readonly callbacks: ObservableCallback<A>[] = [];
  addCallback(callback: ObservableCallback<A>): void {
    this.callbacks.push(callback);
  }
  removeCallback(callback: ObservableCallback<A>): void {
    const index = this.callbacks.indexOf(callback);
    if (index >= 0) this.callbacks.splice(index, 1);
  }
}
