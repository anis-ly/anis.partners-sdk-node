import type { CatalogueCard, CatalogueCategory, CatalogueSubcategory, Page } from '../models/catalogue.js';
import {
  parseCatalogueCard,
  parseCatalogueCategory,
  parseCatalogueSubcategory,
  parsePage,
} from '../models/catalogue.js';
import type { MaskedCard, RevealedCredential, RevealedCredentialCollection } from '../models/cards.js';
import { parseMaskedCard, parseRevealedCredential, parseRevealedCredentialCollection } from '../models/cards.js';
import type { Order, CreateOrderRequest } from '../models/orders.js';
import { parseOrder } from '../models/orders.js';
import type { PartnerProfile, Wallet } from '../models/wallets.js';
import { parsePartnerProfile, parseWallet } from '../models/wallets.js';
import type { SignatureDiagnostic } from '../models/enrollment.js';
import { parseSignatureDiagnostic } from '../models/enrollment.js';
import { Money } from '../models/money.js';
import { EMPTY_OBJECT_BODY } from '../signing/content-digest.js';
import { canonicalUuid } from '../internal/uuid.js';
import type { PartnerTransport } from './partner-transport.js';
import type { OrderResult } from './order-result.js';
import { AnisApiError, refusedAtTheDoor } from '../errors/anis-api-error.js';
import { RequestSigningError } from '../signing/request-signing-error.js';
import { UnverifiableResponseError } from '../verification/unverifiable-response-error.js';
import { safeCounter } from '../internal/safe-telemetry.js';
import { MalformedResponseError } from '../errors/malformed-response-error.js';
import { SigningKeyDocumentUnavailableError } from '../errors/signing-key-document-unavailable-error.js';
import { retryAfterSeconds } from '../internal/retry-after.js';

/** Optional caller cancellation applied to one API call. */
export interface CallOptions {
  /** Stops waiting for this request; for orders, its outcome is still recorded as unknown. */
  signal?: AbortSignal | undefined;
}

/** Optional continuation cursor and cancellation signal for a single page request. */
export interface PageOptions extends CallOptions {
  /** Cursor returned by the preceding page; omit it to read the first page. */
  cursor?: string | undefined;
}

/** Reads the current profile so callers see policy changes. */
export class ProfileOperations {
  /** Shares the client transport so profile reads follow its authority and request signing; the answer is unsigned. */
  constructor(private readonly transport: PartnerTransport) {}
  /** Reads identity and effective scopes from the live policy. */
  async get(options?: CallOptions): Promise<PartnerProfile> {
    return this.transport.json(
      {
        method: 'GET',
        route: '/v1/profile',
        path: '/v1/profile',
        profile: 'SafeRead',
        signal: options?.signal,
      },
      parsePartnerProfile,
    );
  }
}

/** Lists granted wallets and reads one wallet. */
export class WalletOperations {
  /** Shares the client transport so wallet reads follow its authority and request signing; answers are unsigned. */
  constructor(private readonly transport: PartnerTransport) {}
  /** Walks wallet pages so callers need not manage continuation cursors. */
  async *list(options?: CallOptions): AsyncIterable<Wallet> {
    yield* pages((cursor) => this.listPage(pageOptions(cursor, options)));
  }
  /** Reads one page when the caller manages the cursor. */
  async listPage(options?: PageOptions): Promise<Page<Wallet>> {
    return this.transport.json(
      {
        method: 'GET',
        route: '/v1/wallets',
        path: pagePath('/v1/wallets', options?.cursor),
        profile: 'SafeRead',
        signal: options?.signal,
      },
      (json) => parsePage(json, parseWallet),
    );
  }
  /** Reads one granted wallet by canonical UUID. */
  async get(walletId: string, options?: CallOptions): Promise<Wallet> {
    const id = canonicalUuid(walletId, 'walletId');
    return this.transport.json(
      {
        method: 'GET',
        route: '/v1/wallets/{walletId}',
        path: `/v1/wallets/${id}`,
        profile: 'SafeRead',
        signal: options?.signal,
      },
      parseWallet,
    );
  }
}

/** Reads wallet-priced catalogue categories, subcategories, and cards. */
export class CatalogueOperations {
  /** Shares the client transport so catalogue reads use its price and request signing; answers are unsigned. */
  constructor(private readonly transport: PartnerTransport) {}
  /** Walks category pages for a wallet. */
  async *listCategories(walletId: string, options?: CallOptions): AsyncIterable<CatalogueCategory> {
    yield* pages((cursor) => this.listCategoriesPage(walletId, pageOptions(cursor, options)));
  }
  /** Reads one category page. */
  async listCategoriesPage(walletId: string, options?: PageOptions): Promise<Page<CatalogueCategory>> {
    const id = canonicalUuid(walletId, 'walletId');
    return this.transport.json(
      {
        method: 'GET',
        route: '/v1/wallets/{walletId}/catalog/categories',
        path: pagePath(`/v1/wallets/${id}/catalog/categories`, options?.cursor),
        profile: 'SafeRead',
        signal: options?.signal,
      },
      (json) => parsePage(json, parseCatalogueCategory),
    );
  }
  /** Walks subcategory pages. */
  async *listSubcategories(
    walletId: string,
    categoryId: string,
    options?: CallOptions,
  ): AsyncIterable<CatalogueSubcategory> {
    yield* pages((cursor) => this.listSubcategoriesPage(walletId, categoryId, pageOptions(cursor, options)));
  }
  /** Reads one subcategory page. */
  async listSubcategoriesPage(
    walletId: string,
    categoryId: string,
    options?: PageOptions,
  ): Promise<Page<CatalogueSubcategory>> {
    const wallet = canonicalUuid(walletId, 'walletId');
    const category = canonicalUuid(categoryId, 'categoryId');
    const route = '/v1/wallets/{walletId}/catalog/categories/{categoryId}/subcategories';
    return this.transport.json(
      {
        method: 'GET',
        route,
        path: pagePath(`/v1/wallets/${wallet}/catalog/categories/${category}/subcategories`, options?.cursor),
        profile: 'SafeRead',
        signal: options?.signal,
      },
      (json) => parsePage(json, parseCatalogueSubcategory),
    );
  }
  /** Reads one subcategory. */
  async getSubcategory(walletId: string, subcategoryId: string, options?: CallOptions): Promise<CatalogueSubcategory> {
    const wallet = canonicalUuid(walletId, 'walletId');
    const subcategory = canonicalUuid(subcategoryId, 'subcategoryId');
    return this.transport.json(
      {
        method: 'GET',
        route: '/v1/wallets/{walletId}/catalog/subcategories/{subcategoryId}',
        path: `/v1/wallets/${wallet}/catalog/subcategories/${subcategory}`,
        profile: 'SafeRead',
        signal: options?.signal,
      },
      parseCatalogueSubcategory,
    );
  }
  /** Walks card pages for the given wallet and subcategory. */
  async *listCards(walletId: string, subcategoryId: string, options?: CallOptions): AsyncIterable<CatalogueCard> {
    yield* pages((cursor) => this.listCardsPage(walletId, subcategoryId, pageOptions(cursor, options)));
  }
  /** Reads one catalogue card page. */
  async listCardsPage(walletId: string, subcategoryId: string, options?: PageOptions): Promise<Page<CatalogueCard>> {
    const wallet = canonicalUuid(walletId, 'walletId');
    const subcategory = canonicalUuid(subcategoryId, 'subcategoryId');
    const route = '/v1/wallets/{walletId}/catalog/subcategories/{subcategoryId}/cards';
    return this.transport.json(
      {
        method: 'GET',
        route,
        path: pagePath(`/v1/wallets/${wallet}/catalog/subcategories/${subcategory}/cards`, options?.cursor),
        profile: 'SafeRead',
        signal: options?.signal,
      },
      (json) => parsePage(json, parseCatalogueCard),
    );
  }
}

/** Places, resumes, and reads orders under caller-owned operation ids. */
export class OrderOperations {
  /** Shares the verified transport so order recovery uses the same signer and idempotency rules. */
  constructor(private readonly transport: PartnerTransport) {}
  /** Creates an order under an id the caller has persisted, preventing a dropped answer from causing duplicate purchases. */
  create(
    walletId: string,
    operationId: string,
    order: CreateOrderRequest,
    options?: CallOptions,
  ): Promise<OrderResult> {
    return this.send(walletId, operationId, order, false, options);
  }
  /** Repeats the same request and operation id to recover an unknown result. */
  resume(
    walletId: string,
    operationId: string,
    order: CreateOrderRequest,
    options?: CallOptions,
  ): Promise<OrderResult> {
    return this.send(walletId, operationId, order, true, options);
  }
  /** Reads order state without dispatching a new order or returning credentials. */
  async get(operationId: string, options?: CallOptions): Promise<Order> {
    const id = canonicalUuid(operationId, 'operationId');
    return this.transport.json(
      {
        method: 'GET',
        route: '/v1/orders/{operationId}',
        path: `/v1/orders/${id}`,
        profile: 'SafeRead',
        signal: options?.signal,
      },
      parseOrder,
    );
  }
  private async send(
    walletId: string,
    operationId: string,
    order: CreateOrderRequest,
    resuming: boolean,
    options?: CallOptions,
  ): Promise<OrderResult> {
    guardOrder(order);
    const wallet = canonicalUuid(walletId, 'walletId');
    const operation = canonicalUuid(operationId, 'operationId');
    const card = canonicalUuid(order.cardId, 'cardId');
    let bytes: Uint8Array;
    try {
      bytes = new TextEncoder().encode(
        JSON.stringify({
          cardId: card,
          quantity: order.quantity,
          expectedUnitPrice: order.expectedUnitPrice.toJSON(),
          expectedTotal: order.expectedTotal.toJSON(),
          ...(order.externalReference === undefined ? {} : { externalReference: order.externalReference }),
          useAllowedDebt: order.useAllowedDebt ?? false,
        }),
      );
    } catch (cause) {
      throw new RequestSigningError(cause);
    }
    let result: OrderResult;
    let report = true;
    let rethrow = false;
    let cancellation: unknown;
    let outcomeReason: string | undefined;
    try {
      const { response, body } = await this.transport.send({
        method: 'POST',
        route: '/v1/wallets/{walletId}/orders',
        path: `/v1/wallets/${wallet}/orders`,
        profile: 'OrderMutation',
        operationId: operation,
        body: bytes,
        signal: options?.signal,
      });
      if (body.length === 0) {
        outcomeReason = 'empty_body';
        result = {
          kind: 'unknown',
          operationId: operation,
          suggestedDelayMs: 5000,
          cause: emptyBodyError(response.status),
        };
      } else {
        let decoded: unknown;
        try {
          decoded = parseBody(body);
        } catch {
          throw new MalformedResponseError('order response');
        }
        if (decoded === null) {
          outcomeReason = 'empty_body';
          result = {
            kind: 'unknown',
            operationId: operation,
            suggestedDelayMs: 5000,
            cause: emptyBodyError(response.status),
          };
        } else if (response.status === 202) {
          const orderValue = parseOrderSafely(decoded);
          result = {
            kind: 'processing',
            operationId: operation,
            order: orderValue,
            suggestedDelayMs:
              retryAfterSeconds(response.headers.get('retry-after')) === undefined
                ? 5000
                : (retryAfterSeconds(response.headers.get('retry-after')) ?? 0) * 1000,
            ...(response.headers.get('location') === null ? {} : { location: response.headers.get('location') ?? '' }),
          };
        } else {
          const orderValue = parseOrderSafely(decoded);
          const credentials = orderValue.soldCards ?? [];
          if (credentials.length > 0) {
            result = {
              kind: 'completed',
              operationId: operation,
              order: orderValue,
              credentials,
              codesWithheld: orderValue.codesWithheld === true || credentials.length === 0,
            };
          } else if (
            headerValues(response.headers.get('idempotency-replayed')).some((value) => value.toLowerCase() === 'true')
          ) {
            result = { kind: 'replayed', operationId: operation, order: orderValue };
          } else {
            result = {
              kind: 'completed',
              operationId: operation,
              order: orderValue,
              credentials,
              codesWithheld: orderValue.codesWithheld === true || credentials.length === 0,
            };
          }
        }
      }
    } catch (error) {
      if (error instanceof AnisApiError) {
        if (error.orderOutcome === 'notPlaced' && (error.isReplayed || !resuming)) {
          result = { kind: 'notPlaced', operationId: operation, refusal: error };
          report = false;
        } else {
          outcomeReason = error.rawCode ?? 'refused';
          const delay =
            error.retryAfter === undefined ? (refusedAtTheDoor(error.code) ? 60_000 : 5000) : error.retryAfter * 1000;
          result = { kind: 'unknown', operationId: operation, suggestedDelayMs: delay, cause: error };
        }
      } else if (error instanceof RequestSigningError) {
        throw error;
      } else {
        outcomeReason = options?.signal?.aborted ? 'canceled' : errorType(error);
        result = { kind: 'unknown', operationId: operation, suggestedDelayMs: 5000, cause: error };
        rethrow = options?.signal?.aborted ?? false;
        cancellation = error;
      }
    }
    if (report) {
      if (result.kind === 'unknown') {
        result = reportUnknown(
          this.transport,
          operation,
          outcomeReason ?? errorType(result.cause),
          result.cause,
          result.suggestedDelayMs,
        );
      } else {
        result = reportOutcome(this.transport, operation, result);
      }
    }
    if (rethrow) throw cancellation;
    return result;
  }
}

/** Lists owned cards and reveals credentials only on explicit protected calls. */
export class OwnedCardOperations {
  /**
   * Shares the client transport: masked-card reads are answered unsigned, while each reveal answer is verified before
   * a credential is parsed.
   */
  constructor(private readonly transport: PartnerTransport) {}
  /** Walks owned-card pages. */
  async *list(walletId: string, options?: CallOptions): AsyncIterable<MaskedCard> {
    yield* pages((cursor) => this.listPage(walletId, pageOptions(cursor, options)));
  }
  /** Reads one owned-card page. */
  async listPage(walletId: string, options?: PageOptions): Promise<Page<MaskedCard>> {
    const wallet = canonicalUuid(walletId, 'walletId');
    return this.transport.json(
      {
        method: 'GET',
        route: '/v1/wallets/{walletId}/cards',
        path: pagePath(`/v1/wallets/${wallet}/cards`, options?.cursor),
        profile: 'SafeRead',
        signal: options?.signal,
      },
      (json) => parsePage(json, parseMaskedCard),
    );
  }
  /** Reads a masked owned card. */
  async get(walletId: string, soldCardId: string, options?: CallOptions): Promise<MaskedCard> {
    const wallet = canonicalUuid(walletId, 'walletId');
    const card = canonicalUuid(soldCardId, 'soldCardId');
    return this.transport.json(
      {
        method: 'GET',
        route: '/v1/wallets/{walletId}/cards/{soldCardId}',
        path: `/v1/wallets/${wallet}/cards/${card}`,
        profile: 'SafeRead',
        signal: options?.signal,
      },
      parseMaskedCard,
    );
  }
  /** Reveals one credential using a signed mutation with no body bytes. */
  async reveal(walletId: string, soldCardId: string, options?: CallOptions): Promise<RevealedCredential> {
    const wallet = canonicalUuid(walletId, 'walletId');
    const card = canonicalUuid(soldCardId, 'soldCardId');
    return this.transport.json(
      {
        method: 'POST',
        route: '/v1/wallets/{walletId}/cards/{soldCardId}/reveal',
        path: `/v1/wallets/${wallet}/cards/${card}/reveal`,
        profile: 'BodylessNonceMutation',
        signal: options?.signal,
      },
      parseRevealedCredential,
    );
  }
  /** Reveals every credential on an invoice atomically. */
  async revealInvoice(
    walletId: string,
    invoiceId: string,
    options?: CallOptions,
  ): Promise<RevealedCredentialCollection> {
    const wallet = canonicalUuid(walletId, 'walletId');
    const invoice = canonicalUuid(invoiceId, 'invoiceId');
    const route = '/v1/wallets/{walletId}/invoices/{invoiceId}/cards/reveal';
    return this.transport.json(
      {
        method: 'POST',
        route,
        path: `/v1/wallets/${wallet}/invoices/${invoice}/cards/reveal`,
        profile: 'BodylessNonceMutation',
        signal: options?.signal,
      },
      parseRevealedCredentialCollection,
    );
  }
}

/** Runs the signed, side-effect-free signature admission diagnostic. */
export class DiagnosticsOperations {
  /** Shares the verified transport so the self-check uses the same request as the partner API. */
  constructor(private readonly transport: PartnerTransport) {}
  /** Sends the exact empty JSON object expected by the self-check route. */
  async checkSignature(options?: CallOptions): Promise<SignatureDiagnostic> {
    return this.transport.json(
      {
        method: 'POST',
        route: '/v1/diagnostics/signature',
        path: '/v1/diagnostics/signature',
        profile: 'BodylessNonceMutation',
        body: EMPTY_OBJECT_BODY,
        signal: options?.signal,
      },
      parseSignatureDiagnostic,
    );
  }
}

async function* pages<T>(load: (cursor?: string) => Promise<Page<T>>): AsyncIterable<T> {
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  do {
    const page = await load(cursor);
    for (const item of page.items) yield item;
    cursor = page.nextCursor;
    if (cursor !== undefined && cursor.length > 0) {
      if (seenCursors.has(cursor)) throw new MalformedResponseError('page continuation cursor');
      seenCursors.add(cursor);
    }
  } while (cursor !== undefined && cursor.length > 0);
}
function pagePath(path: string, cursor?: string): string {
  return cursor === undefined || cursor.length === 0 ? path : `${path}?cursor=${encodeURIComponent(cursor)}`;
}
function pageOptions(cursor: string | undefined, options?: CallOptions): PageOptions {
  return {
    ...(cursor === undefined ? {} : { cursor }),
    signal: options?.signal,
  };
}
function parseBody(body: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(body)) as unknown;
}
function parseOrderSafely(value: unknown): Order {
  try {
    return parseOrder(value);
  } catch {
    throw new MalformedResponseError('order response');
  }
}
function headerValues(value: string | null): string[] {
  return value === null ? [] : value.split(',').map((part) => part.trim());
}
function guardOrder(order: CreateOrderRequest): void {
  if (!Number.isInteger(order.quantity) || order.quantity < 1)
    throw new RangeError('An order must be for at least one card.');
  canonicalUuid(order.cardId, 'cardId');
  if (!(order.expectedUnitPrice instanceof Money) || !(order.expectedTotal instanceof Money))
    throw new TypeError('Order prices must be Money values.');
  if (BigInt(order.expectedUnitPrice.amount.replace('.', '')) <= 0n)
    throw new RangeError('ExpectedUnitPrice must be greater than zero.');
  if (order.expectedUnitPrice.multiply(order.quantity).amount !== order.expectedTotal.amount)
    throw new TypeError('ExpectedTotal must equal unit price multiplied by quantity.');
  if (order.expectedUnitPrice.currency !== order.expectedTotal.currency)
    throw new TypeError('Order prices must use the same currency.');
}
function reportOutcome<T extends OrderResult>(transport: PartnerTransport, operationId: string, result: T): T {
  safeCounter('anis.partners.order.outcomes', {
    'anis.client': transport.clientName,
    'anis.order.outcome': result.kind,
  });
  transport.reportOrderOutcome(operationId, result.kind);
  return result;
}
function reportUnknown(
  transport: PartnerTransport,
  operationId: string,
  reason: string,
  cause: unknown,
  suggestedDelayMs = 5000,
): OrderResult {
  safeCounter('anis.partners.order.outcomes', {
    'anis.client': transport.clientName,
    'anis.order.outcome': 'unknown',
    'error.type': reason,
  });
  transport.reportOrderOutcome(operationId, 'unknown', reason);
  return { kind: 'unknown', operationId, suggestedDelayMs, cause };
}

function errorType(error: unknown): string {
  if (error instanceof MalformedResponseError) return 'other';
  if (error instanceof SigningKeyDocumentUnavailableError) return 'connection';
  if (error instanceof UnverifiableResponseError) return 'unverifiable';
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'timeout';
  if (error instanceof TypeError) return 'connection';
  if (error instanceof SyntaxError) return 'invalid_json';
  return error instanceof Error ? error.name : 'other';
}

function emptyBodyError(status: number): AnisApiError {
  return new AnisApiError({ status, code: 'internal_error', title: 'Empty body' }, status);
}
