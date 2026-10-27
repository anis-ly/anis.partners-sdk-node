import { parseProductPage, type ProductPage } from '../models/product-page.js';
import { Money } from '../models/money.js';
import { canonicalUuid } from '../internal/uuid.js';
import { MalformedResponseError } from '../errors/malformed-response-error.js';
import { EMPTY_OBJECT_BODY } from '../signing/content-digest.js';
import {
  parseMeterPackage,
  parseMeterCharge,
  parseMeterChargeAccepted,
  parseMeterChargeSummary,
  type CreateMeterChargeRequest,
  type MeterPackage,
  type MeterCharge,
  type MeterChargeAccepted,
  type MeterChargeStatus,
  type MeterChargeSummary,
} from '../models/meter-charges.js';
import {
  parseDirectRechargeProduct,
  parseDirectRechargeProductSummary,
  parseDirectRechargeLocation,
  parseDirectRechargeQuote,
  parseDirectRechargeAmountIn,
  type DirectRechargeProduct,
  type DirectRechargeProductSummary,
  type DirectRechargeProductType,
  type DirectRechargeLocation,
  type DirectRechargeQuote,
  type DirectRechargeAmountIn,
} from '../models/direct-recharge-products.js';
import {
  parseDirectRecharge,
  parseDirectRechargeAccepted,
  parseDirectRechargeSummary,
  parseDirectRechargeRecipientInput,
  type DirectRecharge,
  type DirectRechargeAccepted,
  type DirectRechargeStatus,
  type DirectRechargeSummary,
  type CreateDirectRechargeRequest,
  type UpdateDirectRechargeRecipientRequest,
} from '../models/direct-recharges.js';
import {
  parseWebhookEndpoint,
  parseWebhookEvent,
  parseWebhookEventAccepted,
  type WebhookEndpoint,
  type SetWebhookEndpointRequest,
  type WebhookEvent,
  type WebhookEventAccepted,
  type WebhookDeliveryStatus,
} from '../models/webhooks.js';
import type { MeterChargeResult, DirectRechargeResult, DirectRechargeProcessing } from './product-results.js';
import type { CallOptions, PageOptions } from './operations.js';
import type { PartnerTransport } from './partner-transport.js';
import { processingDelayMs, productBody, sendProduct } from './product-send.js';

/** Wallet charge list filters, retained across continuation pages. */
export interface MeterChargesOptions extends PageOptions {
  /** Known charge status filter. */ status?: Exclude<MeterChargeStatus, 'unknown'> | undefined;
  /** Exact meter spelling. */ meterNumber?: string | undefined;
  /** Inclusive UTC lower bound. */ from?: Date | undefined;
  /** Inclusive UTC upper bound. */ to?: Date | undefined;
  /** Server page size, 1 through 100. */ pageSize?: number | undefined;
}
/** Wallet direct recharge list filters, retained across continuation pages. */
export interface DirectRechargesOptions extends PageOptions {
  /** Merged owner state filter. */ status?: Exclude<DirectRechargeStatus, 'unknown'> | undefined;
  /** Selected product UUID. */ productId?: string | undefined;
  /** Inclusive UTC lower bound. */ from?: Date | undefined;
  /** Inclusive UTC upper bound. */ to?: Date | undefined;
  /** Server page size, 1 through 100. */ pageSize?: number | undefined;
}
/** Product catalogue filters. */
export interface DirectRechargeProductsOptions extends PageOptions {
  /** Published product kind. */ type?: Exclude<DirectRechargeProductType, 'unknown'> | undefined;
}
/** Searchable location collection options. */
export interface DirectRechargeLocationsOptions extends PageOptions {
  /** Owner name search, encoded once. */ search?: string | undefined;
}
/** Webhook delivery list options; the server page size is fixed. */
export interface WebhookEventsOptions extends PageOptions {
  /** Delivery state filter. */ status?: Exclude<WebhookDeliveryStatus, 'unknown'> | undefined;
  /** Inclusive event time lower bound. */ since?: Date | undefined;
}

/** Reads packages and places, recovers and reads caller-keyed meter charges. */
export class MeterChargeOperations {
  /** Shares the signed client pipeline. */
  constructor(private readonly transport: PartnerTransport) {}
  /** Reads one page of wallet-priced packages. */
  async getMeterPackagesPage(walletId: string, options?: PageOptions): Promise<ProductPage<MeterPackage>> {
    const wallet = canonicalUuid(walletId, 'walletId');
    return readPage(
      this.transport,
      '/v1/wallets/{walletId}/meter-packages',
      `/v1/wallets/${wallet}/meter-packages`,
      { cursor: options?.cursor },
      parseMeterPackage,
      options,
    );
  }
  /** Walks packages until the server supplies no cursor. */
  async *getMeterPackages(walletId: string, options?: CallOptions): AsyncIterable<MeterPackage> {
    yield* pages((cursor) => this.getMeterPackagesPage(walletId, { ...options, cursor }));
  }
  /** Reads one wallet charge summary page without receipt data. */
  async getMeterChargesPage(walletId: string, options?: MeterChargesOptions): Promise<ProductPage<MeterChargeSummary>> {
    const wallet = canonicalUuid(walletId, 'walletId');
    return readPage(
      this.transport,
      '/v1/wallets/{walletId}/meter-charges',
      `/v1/wallets/${wallet}/meter-charges`,
      { ...listQuery(options), meterNumber: options?.meterNumber },
      parseMeterChargeSummary,
      options,
    );
  }
  /** Walks the bounded charge window with unchanged filters. */
  async *getMeterCharges(walletId: string, options?: MeterChargesOptions): AsyncIterable<MeterChargeSummary> {
    yield* pages((cursor) => this.getMeterChargesPage(walletId, { ...options, cursor }), options?.cursor);
  }
  /** Sends a persisted operation id and intent once. */
  create(
    walletId: string,
    operationId: string,
    request: CreateMeterChargeRequest,
    options?: CallOptions,
  ): Promise<MeterChargeResult> {
    return this.send(walletId, operationId, request, false, options);
  }
  /** Recovers with the identical saved id and intent, using a fresh nonce. */
  resume(
    walletId: string,
    operationId: string,
    request: CreateMeterChargeRequest,
    options?: CallOptions,
  ): Promise<MeterChargeResult> {
    return this.send(walletId, operationId, request, true, options);
  }
  /** Reads signed owner state or a processing acknowledgement before projection. */
  async get(operationId: string, options?: CallOptions): Promise<MeterCharge | MeterChargeAccepted> {
    const id = canonicalUuid(operationId, 'operationId');
    return readProduct(
      this.transport,
      '/v1/meter-charges/{operationId}',
      `/v1/meter-charges/${id}`,
      id,
      parseMeterChargeAccepted,
      parseMeterCharge,
      options,
    );
  }
  private async send(
    walletId: string,
    operationId: string,
    request: CreateMeterChargeRequest,
    resuming: boolean,
    options?: CallOptions,
  ): Promise<MeterChargeResult> {
    const wallet = canonicalUuid(walletId, 'walletId');
    const operation = canonicalUuid(operationId, 'operationId');
    const packageId = canonicalUuid(request.packageId, 'packageId');
    guardTotal(request.expectedTotal);
    if (typeof request.meterNumber !== 'string') throw new TypeError('meterNumber must be a string.');
    const body = productBody(() => ({
      packageId,
      meterNumber: request.meterNumber,
      expectedTotal: productMoney(request.expectedTotal),
      ...(request.externalReference === undefined ? {} : { externalReference: request.externalReference }),
    }));
    const result = await sendProduct(
      this.transport,
      {
        route: '/v1/wallets/{walletId}/meter-charges',
        path: `/v1/wallets/${wallet}/meter-charges`,
        operationId: operation,
        body,
        resuming,
        accepted: parseMeterChargeAccepted,
        read: parseMeterCharge,
        final: (charge) =>
          charge.status === 'succeeded' ||
          (charge.status === 'failed' &&
            (charge.refund?.status === 'refunded' || charge.refund?.status === 'notCharged')),
      },
      options,
    );
    if (result.kind === 'unknown' || result.kind === 'notPlaced') return result;
    const { value, kind, ...common } = result;
    if ('operationType' in value) return { ...common, kind: 'processing', accepted: value };
    return kind === 'final'
      ? { kind, operationId: operation, meterCharge: value }
      : { ...common, kind, meterCharge: value };
  }
}

/** Reads products, their dynamic recipient fields, locations and quotes. */
export class DirectRechargeProductOperations {
  /** Shares the signed client pipeline; catalogue answers are unsigned. */
  constructor(private readonly transport: PartnerTransport) {}
  /** Reads one wallet-priced product page. */
  async getDirectRechargeProductsPage(
    walletId: string,
    options?: DirectRechargeProductsOptions,
  ): Promise<ProductPage<DirectRechargeProductSummary>> {
    const wallet = canonicalUuid(walletId, 'walletId');
    return readPage(
      this.transport,
      '/v1/wallets/{walletId}/direct-recharge-products',
      `/v1/wallets/${wallet}/direct-recharge-products`,
      { type: options?.type, cursor: options?.cursor },
      parseDirectRechargeProductSummary,
      options,
    );
  }
  /** Walks products with the same type filter. */
  async *getDirectRechargeProducts(
    walletId: string,
    options?: DirectRechargeProductsOptions,
  ): AsyncIterable<DirectRechargeProductSummary> {
    yield* pages((cursor) => this.getDirectRechargeProductsPage(walletId, { ...options, cursor }), options?.cursor);
  }
  /** Reads one product and its complete dynamic recipient fields. */
  async get(walletId: string, productId: string, options?: CallOptions): Promise<DirectRechargeProduct> {
    const path = productPath(walletId, productId);
    return this.transport.json(
      {
        method: 'GET',
        route: '/v1/wallets/{walletId}/direct-recharge-products/{productId}',
        path,
        profile: 'SafeRead',
        signal: options?.signal,
      },
      parseDirectRechargeProduct,
    );
  }
  /** Reads one searched location page. */
  async getDirectRechargeProductLocationsPage(
    walletId: string,
    productId: string,
    options?: DirectRechargeLocationsOptions,
  ): Promise<ProductPage<DirectRechargeLocation>> {
    return readPage(
      this.transport,
      '/v1/wallets/{walletId}/direct-recharge-products/{productId}/locations',
      `${productPath(walletId, productId)}/locations`,
      { search: options?.search, cursor: options?.cursor },
      parseDirectRechargeLocation,
      options,
    );
  }
  /** Walks locations with the original search. */
  async *getDirectRechargeProductLocations(
    walletId: string,
    productId: string,
    options?: DirectRechargeLocationsOptions,
  ): AsyncIterable<DirectRechargeLocation> {
    yield* pages(
      (cursor) => this.getDirectRechargeProductLocationsPage(walletId, productId, { ...options, cursor }),
      options?.cursor,
    );
  }
  /** Quotes in dinars or foreign payout currency without reserving funds. */
  async quote(
    walletId: string,
    productId: string,
    amount: string,
    amountIn: DirectRechargeAmountIn,
    options?: CallOptions,
  ): Promise<DirectRechargeQuote> {
    const path = productPath(walletId, productId);
    guardAmount(amount);
    const denomination = parseDirectRechargeAmountIn(amountIn);
    return this.transport.json(
      {
        method: 'GET',
        route: '/v1/wallets/{walletId}/direct-recharge-products/{productId}/quote',
        path: queryPath(`${path}/quote`, { amount, amountIn: denomination }),
        profile: 'SafeRead',
        signal: options?.signal,
      },
      parseDirectRechargeQuote,
    );
  }
}

/** Places, recovers, reads and corrects caller-keyed direct recharges. */
export class DirectRechargeOperations {
  /** Shares the signed client pipeline. */
  constructor(private readonly transport: PartnerTransport) {}
  /** Reads one wallet summary page. */
  async getDirectRechargesPage(
    walletId: string,
    options?: DirectRechargesOptions,
  ): Promise<ProductPage<DirectRechargeSummary>> {
    const wallet = canonicalUuid(walletId, 'walletId');
    const productId = options?.productId === undefined ? undefined : canonicalUuid(options.productId, 'productId');
    return readPage(
      this.transport,
      '/v1/wallets/{walletId}/direct-recharges',
      `/v1/wallets/${wallet}/direct-recharges`,
      { ...listQuery(options), productId },
      parseDirectRechargeSummary,
      options,
    );
  }
  /** Walks the bounded window with the same filters and page size. */
  async *getDirectRecharges(walletId: string, options?: DirectRechargesOptions): AsyncIterable<DirectRechargeSummary> {
    yield* pages((cursor) => this.getDirectRechargesPage(walletId, { ...options, cursor }), options?.cursor);
  }
  /** Sends the persisted intent once under the caller's id. */
  create(
    walletId: string,
    operationId: string,
    request: CreateDirectRechargeRequest,
    options?: CallOptions,
  ): Promise<DirectRechargeResult> {
    return this.send(walletId, operationId, request, false, options);
  }
  /** Repeats the saved intent and id with fresh request signing. */
  resume(
    walletId: string,
    operationId: string,
    request: CreateDirectRechargeRequest,
    options?: CallOptions,
  ): Promise<DirectRechargeResult> {
    return this.send(walletId, operationId, request, true, options);
  }
  /** Reads signed owner state or a strict processing acknowledgement. */
  async get(operationId: string, options?: CallOptions): Promise<DirectRecharge | DirectRechargeAccepted> {
    const id = canonicalUuid(operationId, 'operationId');
    return readProduct(
      this.transport,
      '/v1/direct-recharges/{operationId}',
      `/v1/direct-recharges/${id}`,
      id,
      parseDirectRechargeAccepted,
      parseDirectRecharge,
      options,
    );
  }
  /** Applies a recipient change once and returns the same processing result a 202 create answers, with the verified location. */
  async updateRecipient(
    operationId: string,
    request: UpdateDirectRechargeRecipientRequest,
    options?: CallOptions,
  ): Promise<DirectRechargeProcessing> {
    const id = canonicalUuid(operationId, 'operationId');
    const recipient = recipientInputs(request.recipient);
    const { response, body } = await this.transport.send({
      method: 'PATCH',
      route: '/v1/direct-recharges/{operationId}/recipient',
      path: `/v1/direct-recharges/${id}/recipient`,
      profile: 'BodylessNonceMutation',
      body: productBody(() => ({ recipient })),
      signal: options?.signal,
    });
    try {
      if (response.status !== 202) throw new TypeError('A recipient correction must answer 202.');
      const value: unknown = JSON.parse(new TextDecoder().decode(body));
      const accepted = matchingRead(value, id, parseDirectRechargeAccepted);
      const location = response.headers.get('location');
      const path = `/v1/direct-recharges/${id}`;
      if (location !== path && location !== `${this.transport.authorityOrigin}${path}`)
        throw new TypeError('Location must point to this direct recharge read on the configured authority.');
      return {
        kind: 'processing',
        operationId: id,
        suggestedDelayMs: processingDelayMs(response),
        location,
        accepted,
      };
    } catch {
      throw new MalformedResponseError('recipient correction acknowledgement or Location');
    }
  }
  private async send(
    walletId: string,
    operationId: string,
    request: CreateDirectRechargeRequest,
    resuming: boolean,
    options?: CallOptions,
  ): Promise<DirectRechargeResult> {
    const wallet = canonicalUuid(walletId, 'walletId');
    const operation = canonicalUuid(operationId, 'operationId');
    const productId = canonicalUuid(request.productId, 'productId');
    guardAmount(request.payoutAmount);
    guardTotal(request.expectedTotal);
    const recipient = recipientInputs(request.recipient);
    const body = productBody(() => ({
      productId,
      payoutAmount: request.payoutAmount,
      expectedTotal: productMoney(request.expectedTotal),
      recipient,
      ...(request.note === undefined ? {} : { note: request.note }),
      ...(request.externalReference === undefined ? {} : { externalReference: request.externalReference }),
    }));
    const result = await sendProduct(
      this.transport,
      {
        route: '/v1/wallets/{walletId}/direct-recharges',
        path: `/v1/wallets/${wallet}/direct-recharges`,
        operationId: operation,
        body,
        resuming,
        accepted: parseDirectRechargeAccepted,
        read: parseDirectRecharge,
        final: (recharge) =>
          recharge.status === 'completed' ||
          recharge.status === 'paymentFailed' ||
          recharge.status === 'rejectedWithRefund',
      },
      options,
    );
    if (result.kind === 'unknown' || result.kind === 'notPlaced') return result;
    const { value, kind, ...common } = result;
    if ('operationType' in value) return { ...common, kind: 'processing', accepted: value };
    return kind === 'final'
      ? { kind, operationId: operation, directRecharge: value }
      : { ...common, kind, directRecharge: value };
  }
}

/** Manages the admitted application's single endpoint. */
export class WebhookEndpointOperations {
  /** Shares the signed client pipeline. */
  constructor(private readonly transport: PartnerTransport) {}
  /** Reads endpoint state; the answer is unsigned. */
  async get(options?: CallOptions): Promise<WebhookEndpoint> {
    return this.transport.json(
      {
        method: 'GET',
        route: '/v1/webhook-endpoint',
        path: '/v1/webhook-endpoint',
        profile: 'SafeRead',
        signal: options?.signal,
      },
      parseWebhookEndpoint,
    );
  }
  /** Registers a URL with a signed change, without an idempotency key. */
  async set(request: SetWebhookEndpointRequest, options?: CallOptions): Promise<WebhookEndpoint> {
    if (typeof request.url !== 'string') throw new TypeError('url must be a string.');
    return this.transport.json(
      {
        method: 'PUT',
        route: '/v1/webhook-endpoint',
        path: '/v1/webhook-endpoint',
        profile: 'BodylessNonceMutation',
        body: productBody(() => ({ url: request.url })),
        signal: options?.signal,
      },
      parseWebhookEndpoint,
    );
  }
  /** Queues one test notification, signing the exact empty JSON object. */
  async test(options?: CallOptions): Promise<WebhookEventAccepted> {
    return this.transport.json(
      {
        method: 'POST',
        route: '/v1/webhook-endpoint/test',
        path: '/v1/webhook-endpoint/test',
        profile: 'BodylessNonceMutation',
        body: EMPTY_OBJECT_BODY,
        signal: options?.signal,
      },
      parseWebhookEventAccepted,
    );
  }
}

/** Reads delivery summaries and requests explicit redelivery. */
export class WebhookEventOperations {
  /** Shares the signed client pipeline. */
  constructor(private readonly transport: PartnerTransport) {}
  /** Reads one fixed-size delivery page. */
  async getWebhookEventsPage(options?: WebhookEventsOptions): Promise<ProductPage<WebhookEvent>> {
    return readPage(
      this.transport,
      '/v1/webhook-events',
      '/v1/webhook-events',
      { status: options?.status, since: options?.since?.toISOString(), cursor: options?.cursor },
      parseWebhookEvent,
      options,
    );
  }
  /** Walks deliveries with unchanged status and since filters. */
  async *getWebhookEvents(options?: WebhookEventsOptions): AsyncIterable<WebhookEvent> {
    yield* pages((cursor) => this.getWebhookEventsPage({ ...options, cursor }), options?.cursor);
  }
  /** Requests redelivery of the original event once, without purchase idempotency. */
  async redeliver(eventId: string, options?: CallOptions): Promise<WebhookEventAccepted> {
    const id = canonicalUuid(eventId, 'eventId');
    return this.transport.json(
      {
        method: 'POST',
        route: '/v1/webhook-events/{eventId}/redeliver',
        path: `/v1/webhook-events/${id}/redeliver`,
        profile: 'BodylessNonceMutation',
        body: EMPTY_OBJECT_BODY,
        signal: options?.signal,
      },
      (value) => {
        const accepted = parseWebhookEventAccepted(value);
        if (accepted.id !== id) throw new TypeError('Mismatched redelivery event id.');
        return accepted;
      },
    );
  }
}

function productPath(walletId: string, productId: string): string {
  return `/v1/wallets/${canonicalUuid(walletId, 'walletId')}/direct-recharge-products/${canonicalUuid(productId, 'productId')}`;
}
function productMoney(total: Money): { amount: string; currency: string } {
  return { amount: total.amount, currency: total.currency };
}
function guardTotal(total: Money): void {
  if (!(total instanceof Money)) throw new TypeError('expectedTotal must be Money.');
  if (total.currency !== 'LYD' || BigInt(total.amount.replace('.', '')) <= 0n)
    throw new RangeError('expectedTotal must be positive LYD.');
}
function guardAmount(amount: string): void {
  if (
    typeof amount !== 'string' ||
    !/^(?:0|[1-9]\d{0,14})\.\d{3}$/.test(amount) ||
    BigInt(amount.replace('.', '')) <= 0n
  )
    throw new TypeError('Amount must be a positive fixed-scale decimal string.');
}
function recipientInputs(value: readonly unknown[]) {
  if (!Array.isArray(value)) throw new TypeError('recipient must be an array.');
  return value.map(parseDirectRechargeRecipientInput);
}
function queryPath(path: string, fields: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) query.set(key, String(value));
  return query.size === 0 ? path : `${path}?${query.toString()}`;
}
function listQuery(options?: MeterChargesOptions | DirectRechargesOptions) {
  return {
    status: options?.status,
    from: options?.from?.toISOString(),
    to: options?.to?.toISOString(),
    cursor: options?.cursor,
    pageSize: options?.pageSize,
  };
}
async function readPage<T>(
  transport: PartnerTransport,
  route: string,
  path: string,
  query: Record<string, string | number | undefined>,
  parse: (value: unknown) => T,
  options?: CallOptions,
): Promise<ProductPage<T>> {
  return transport.json(
    { method: 'GET', route, path: queryPath(path, query), profile: 'SafeRead', signal: options?.signal },
    (value) => parseProductPage(value, parse),
  );
}
async function* pages<T>(
  get: (cursor: string | undefined) => Promise<ProductPage<T>>,
  cursor?: string,
): AsyncIterable<T> {
  const seenCursors = new Set<string>();
  if (cursor !== undefined) seenCursors.add(cursor);
  do {
    const page = await get(cursor);
    yield* page.items;
    cursor = page.nextCursor == null || page.nextCursor.length === 0 ? undefined : page.nextCursor;
    if (cursor !== undefined) {
      if (seenCursors.has(cursor)) throw new MalformedResponseError('page continuation cursor');
      seenCursors.add(cursor);
    }
  } while (cursor !== undefined);
}
function matchingRead<T extends { operationId: string }>(
  value: unknown,
  operationId: string,
  parse: (value: unknown) => T,
): T {
  const read = parse(value);
  if (read.operationId !== operationId) throw new TypeError('Mismatched operation id.');
  return read;
}
async function readProduct<A extends { operationId: string }, T extends { operationId: string }>(
  transport: PartnerTransport,
  route: string,
  path: string,
  operationId: string,
  accepted: (value: unknown) => A,
  read: (value: unknown) => T,
  options?: CallOptions,
): Promise<A | T> {
  const { response, body } = await transport.send({
    method: 'GET',
    route,
    path,
    profile: 'SafeRead',
    signal: options?.signal,
  });
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(body));
    if (response.status === 202) return matchingRead(value, operationId, accepted);
    if (response.status === 200) return matchingRead(value, operationId, read);
    throw new TypeError('Unexpected product read status.');
  } catch {
    throw new MalformedResponseError('product response');
  }
}
