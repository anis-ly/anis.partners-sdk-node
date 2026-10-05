/**
 * The narrow key-custody seam: sign exact bytes and return ECDSA P-256 / SHA-256 in IEEE P1363 r‖s form.
 *
 * @remarks Accepting bytes instead of a key object lets a partner keep keys in its own vault or HSM. Exactly 64
 * bytes prevent DER's alternate encoding of a mathematically valid signature from reaching Anis as a request error.
 */
export interface P256Signer {
  /** Signs these bytes and returns exactly 64 bytes; DER has a different wire form and Anis refuses it. */
  sign(data: Uint8Array): Promise<Uint8Array>;
}

/** A signer identified by the credential that Anis issued at enrollment. */
export interface RequestSigner extends P256Signer {
  /** The canonical request key ID; treating it as an identifier avoids late authentication failures. */
  readonly keyId: string;
}
