import type { ClientOptions } from './client-options.js';
import { validateClientOptions } from './client-options.js';
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
  fetch?: typeof globalThis.fetch;
  /** Shared key-document cache for short-lived/serverless hosts. */
  keyCache?: KeyDocumentCache;
  /** Optional structured partner log sink. */
  logger?: PartnerLogger;
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
    const fetcher = input.fetch ?? globalThis.fetch;
    const logger = input.logger;
    const keyLogger: SigningKeyLogger | undefined =
      logger === undefined
        ? undefined
        : {
            debug(message, fields) {
              logger.debug(message, { ...fields, eventId: 1005 });
            },
          };
    const keySource = new HttpSigningKeySource({
      authority: options.authority,
      cacheSeconds: options.signingKeyCacheSeconds,
      fetch: async (resource, init = {}) => {
        const signals = [AbortSignal.timeout(options.timeoutMs)];
        if (init.signal != null) signals.push(init.signal);
        return fetcher(resource, { ...init, signal: AbortSignal.any(signals) });
      },
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
