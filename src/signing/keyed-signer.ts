import type { P256Signer, RequestSigner } from './p256-signer.js';
import { canonicalUuid } from '../internal/uuid.js';

/**
 * Associates an external signer with the credential UUID used in request signatures.
 *
 * @remarks Keeping key custody behind the byte-signing seam lets a partner use a vault or HSM without exporting its
 * private key into this process.
 */
export class KeyedSigner implements RequestSigner {
  /** The enrolled credential identifier, canonicalized so Anis can resolve it. */
  readonly keyId: string;

  /** Creates a binding; canonical identity avoids a valid signature that names an unknown credential. */
  constructor(
    private readonly signer: P256Signer,
    keyId: string,
  ) {
    this.keyId = canonicalUuid(keyId, 'keyId');
  }
  /** Signs exact bytes through partner-owned key custody without exposing key material. */
  sign(data: Uint8Array): Promise<Uint8Array> {
    return this.signer.sign(data);
  }
}
