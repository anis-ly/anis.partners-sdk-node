import { fixedTimeEqual } from '../internal/bytes.js';
import { canonicalUuid } from '../internal/uuid.js';
import { keyThumbprint } from './key-thumbprint.js';
import { safetyCodeFromThumbprint } from './safety-code.js';
import { proofMessage, proofSignature } from './enrollment-proof.js';
import type {
  EnrollmentKeyRequest,
  EnrollmentKeyResult,
  EnrollmentProofRequest,
  EnrollmentState,
  EnrollmentStatus,
} from '../models/enrollment.js';
import { parseEnrollmentKeyResult, parseEnrollmentState, parseEnrollmentStatus } from '../models/enrollment.js';
import type { P256Signer } from '../signing/p256-signer.js';
import type { PartnerTransport } from '../operations/partner-transport.js';
import { PartnerTransport as Transport } from '../operations/partner-transport.js';
import type { TransportOptions } from '../operations/partner-transport.js';
import { validateClientOptions, type ClientOptions } from '../client-options.js';
import { HttpSigningKeySource, type KeyDocumentCache } from '../verification/http-signing-key-source.js';
import type { PartnerLogger } from '../observability/logger.js';
import { AnisPartnersError } from '../errors/anis-partners-error.js';
import { safeLog } from '../internal/safe-telemetry.js';

/** Settings for an enrollment invitation before an active request key exists. */
export interface AnisEnrollmentClientOptions {
  /** Issued Anis authority. */
  authority: string | URL;
  /** Invitation UUID being enrolled. */
  invitationId: string;
  /** Secret invitation token; it is sent only in Authorization and never logged. */
  enrollmentToken: string;
  /** Injectable fetch for proxies and in-memory API doubles. */
  fetch?: typeof globalThis.fetch | undefined;
  /** Shared key-document cache for short-lived hosts. */
  keyCache?: KeyDocumentCache | undefined;
  /** Optional structured log sink. */
  logger?: Partial<PartnerLogger> | undefined;
  /** Cache lifetime for the unsigned public response-key document. */
  signingKeyCacheSeconds?: number | undefined;
  /** Per-request timeout. */
  timeoutMs?: number | undefined;
}

/** Raised when the verified challenge names a different key than the one submitted. */
export class EnrollmentKeyMismatchError extends AnisPartnersError {
  /** Thumbprint calculated from the public key submitted by this caller. */
  readonly localThumbprint: string;
  /** Thumbprint returned by Anis, when present. */
  readonly serverThumbprint?: string;
  /** Stops a proof from being made with a challenge bound to another key. */
  constructor(localThumbprint: string, serverThumbprint?: string) {
    super(
      'The key Anis holds differs from the one submitted. Do not prove possession; ask Anis to restart enrollment.',
    );
    this.localThumbprint = localThumbprint;
    if (serverThumbprint !== undefined) this.serverThumbprint = serverThumbprint;
  }
}

/** Enrollment flow, authenticated by its one-time token and still verifying every answer. */
export class AnisEnrollmentClient {
  private readonly transport: PartnerTransport;
  private readonly invitation: string;
  readonly #token: string;
  private constructor(transport: PartnerTransport, invitationId: string, token: string) {
    this.transport = transport;
    this.invitation = canonicalUuid(invitationId, 'invitationId');
    this.#token = token;
  }
  /** Creates an enrollment client over the same mandatory response-verification pipeline. */
  static create(input: AnisEnrollmentClientOptions): AnisEnrollmentClient {
    if (input.enrollmentToken.trim().length === 0 || hasControlCharacters(input.enrollmentToken))
      throw new TypeError('The enrollment token must be non-blank and contain no control characters.');
    const options = validateClientOptions({
      authority: input.authority,
      ...(input.signingKeyCacheSeconds === undefined ? {} : { signingKeyCacheSeconds: input.signingKeyCacheSeconds }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    } satisfies ClientOptions);
    const fetcher = input.fetch ?? globalThis.fetch;
    const keySource = new HttpSigningKeySource({
      authority: options.authority,
      cacheSeconds: options.signingKeyCacheSeconds,
      fetch: fetcher,
      ...(input.keyCache === undefined ? {} : { documentCache: input.keyCache }),
      ...(input.logger === undefined
        ? {}
        : {
            logger: {
              debug(message: string, fields: Record<string, unknown>) {
                safeLog(input.logger, 'debug', message, fields);
              },
              info(message: string, fields: Record<string, unknown>) {
                safeLog(input.logger, 'info', message, { ...fields, eventId: 1005 });
              },
              warn(message: string, fields: Record<string, unknown>) {
                safeLog(input.logger, 'warn', message, fields);
              },
            },
          }),
    });
    const transportOptions: TransportOptions = {
      ...options,
      fetcher,
      keySource,
      ...(input.logger === undefined ? {} : { logger: input.logger }),
    };
    return new AnisEnrollmentClient(new Transport(transportOptions), input.invitationId, input.enrollmentToken);
  }
  /** Reads invitation state. */
  async get(options?: { signal?: AbortSignal }): Promise<EnrollmentState> {
    return this.transport.json(
      {
        method: 'GET',
        route: '/v1/enrollments/{invitationId}',
        path: `/v1/enrollments/${this.invitation}`,
        enrollmentToken: this.#token,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      },
      parseEnrollmentState,
    );
  }
  /** Reads approval and key-expiry state. */
  async getStatus(options?: { signal?: AbortSignal }): Promise<EnrollmentStatus> {
    return this.transport.json(
      {
        method: 'GET',
        route: '/v1/enrollments/{invitationId}/status',
        path: `/v1/enrollments/${this.invitation}/status`,
        enrollmentToken: this.#token,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      },
      parseEnrollmentStatus,
    );
  }
  /** Submits a public key, then checks the verified answer against its local RFC 7638 thumbprint. */
  async submitKey(request: EnrollmentKeyRequest, options?: { signal?: AbortSignal }): Promise<EnrollmentKeyResult> {
    rejectPrivateMembers(request.publicJwk);
    const local = keyThumbprint(request.publicJwk);
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        publicJwk: {
          kty: request.publicJwk.kty,
          crv: request.publicJwk.crv,
          x: request.publicJwk.x,
          y: request.publicJwk.y,
        },
        notBefore: request.notBefore,
        expiresAt: request.expiresAt,
      }),
    );
    const answer = await this.transport.json(
      {
        method: 'POST',
        route: '/v1/enrollments/{invitationId}/keys',
        path: `/v1/enrollments/${this.invitation}/keys`,
        body: bytes,
        enrollmentToken: this.#token,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      },
      parseEnrollmentKeyResult,
    );
    if (
      answer.thumbprint === undefined ||
      !fixedTimeEqual(new TextEncoder().encode(local), new TextEncoder().encode(answer.thumbprint))
    )
      throw new EnrollmentKeyMismatchError(local, answer.thumbprint);
    return { ...answer, safetyCode: safetyCodeFromThumbprint(local) };
  }
  /** Builds the possession message, obtains its P-256 signature, and submits the proof. */
  async prove(
    submitted: EnrollmentKeyResult,
    signer: P256Signer,
    options?: { signal?: AbortSignal },
  ): Promise<EnrollmentStatus> {
    const message = proofMessage(
      submitted.keyId,
      submitted.challengeGeneration ?? missing('challengeGeneration'),
      submitted.challenge ?? missing('challenge'),
      submitted.thumbprint ?? missing('thumbprint'),
    );
    const signature = await proofSignature(message, signer);
    return this.submitProof(
      {
        keyId: submitted.keyId,
        challengeGeneration: submitted.challengeGeneration ?? missing('challengeGeneration'),
        signature,
      },
      options,
    );
  }
  /** Submits a previously prepared proof for the current challenge generation. */
  async submitProof(request: EnrollmentProofRequest, options?: { signal?: AbortSignal }): Promise<EnrollmentStatus> {
    return this.transport.json(
      {
        method: 'POST',
        route: '/v1/enrollments/{invitationId}/proof',
        path: `/v1/enrollments/${this.invitation}/proof`,
        body: new TextEncoder().encode(
          JSON.stringify({
            keyId: request.keyId,
            challengeGeneration: request.challengeGeneration,
            signature: request.signature,
          }),
        ),
        enrollmentToken: this.#token,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      },
      parseEnrollmentStatus,
    );
  }
}

const privateJwkMembers = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'] as const;

function rejectPrivateMembers(jwk: object): void {
  for (const member of privateJwkMembers) {
    if (Object.hasOwn(jwk, member)) throw new TypeError('Enrollment accepts a public JWK only.');
  }
}
function missing(member: string): never {
  throw new TypeError(`Enrollment key answer has no ${member}.`);
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}
