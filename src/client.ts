import type { ClientOptions } from './client-options.js';
import { validateClientOptions } from './client-options.js';
import { canonicalUuid } from './internal/uuid.js';
import { safeLog } from './internal/safe-telemetry.js';
import type { RequestSigner } from './signing/p256-signer.js';
import type { KeyDocumentCache, SigningKeyLogger } from './verification/http-signing-key-source.js';
import { HttpSigningKeySource } from './verification/http-signing-key-source.js';
import type { PartnerLogger } from './observability/logger.js';
import { PartnerTransport } from './operations/partner-transport.js';
import {
  CatalogueOperations,
  DiagnosticsOperations,
  OrderOperations,
  OwnedCardOperations,
  ProfileOperations,
  WalletOperations,
} from './operations/operations.js';

/** Dependencies used to create a signed and verified client. */
export interface AnisPartnersClientCreateOptions {
  /** Validated authority and request settings. */
  options: ClientOptions;
  /** Partner key custody; signatures must be 64-byte P-256 P1363. */
  signer: RequestSigner;
  /** Injectable fetch for proxies and in-memory API doubles. */
  fetch?: typeof globalThis.fetch | undefined;
  /** Shared key-document cache for short-lived/serverless hosts. */
  keyCache?: KeyDocumentCache | undefined;
  /** Optional structured partner log sink. */
  logger?: Partial<PartnerLogger> | undefined;
}

/** Node client whose requests are signed and whose complete responses are verified before parsing. */
export class AnisPartnersClient {
  /** Reads identity and live scopes. */
  readonly profile: ProfileOperations;
  /** Lists wallets available to this application. */
  readonly wallets: WalletOperations;
  /** Reads wallet-priced catalogue entries. */
  readonly catalogue: CatalogueOperations;
  /** Creates and resumes caller-keyed orders. */
  readonly orders: OrderOperations;
  /** Reads owned cards and reveals credentials. */
  readonly ownedCards: OwnedCardOperations;
  /** Runs the side-effect-free signature check. */
  readonly diagnostics: DiagnosticsOperations;

  private constructor(transport: PartnerTransport) {
    this.profile = new ProfileOperations(transport);
    this.wallets = new WalletOperations(transport);
    this.catalogue = new CatalogueOperations(transport);
    this.orders = new OrderOperations(transport);
    this.ownedCards = new OwnedCardOperations(transport);
    this.diagnostics = new DiagnosticsOperations(transport);
  }

  /** Builds the grouped API client and its unsigned public key-document source. */
  static create(input: AnisPartnersClientCreateOptions): AnisPartnersClient {
    const options = validateClientOptions(input.options);
    const signer: unknown = (input as { signer?: unknown }).signer;
    if (typeof signer !== 'object' || signer === null || !('sign' in signer) || typeof signer.sign !== 'function')
      throw new TypeError('A request signer with a sign method is required.');
    if (!('keyId' in signer) || typeof signer.keyId !== 'string')
      throw new TypeError('The request signer needs a key id.');
    canonicalUuid(signer.keyId, 'signer.keyId');
    const fetcher = input.fetch ?? globalThis.fetch;
    const logger = input.logger;
    const keyLogger: SigningKeyLogger | undefined =
      logger === undefined
        ? undefined
        : {
            debug(message, fields) {
              safeLog(logger, 'debug', message, fields);
            },
            info(message, fields) {
              safeLog(logger, 'info', message, { ...fields, eventId: 1005 });
            },
            warn(message, fields) {
              safeLog(logger, 'warn', message, fields);
            },
          };
    const keySource = new HttpSigningKeySource({
      authority: options.authority,
      cacheSeconds: options.signingKeyCacheSeconds,
      fetch: fetcher,
      ...(input.keyCache === undefined ? {} : { documentCache: input.keyCache }),
      ...(keyLogger === undefined ? {} : { logger: keyLogger }),
    });
    const transport = new PartnerTransport({
      ...options,
      signer: input.signer,
      fetcher,
      keySource,
      ...(logger === undefined ? {} : { logger }),
    });
    return new AnisPartnersClient(transport);
  }
}
