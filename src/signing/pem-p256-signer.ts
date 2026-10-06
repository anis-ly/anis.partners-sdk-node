import { readFile } from 'node:fs/promises';
import { KeyedSigner } from './keyed-signer.js';
import type { P256Signer } from './p256-signer.js';
import type { PartnerJwk } from '../verification/partner-jwk.js';
import { arrayBufferOf } from '../internal/bytes.js';
import { PrivateKeyError } from '../errors/private-key-error.js';

/**
 * Signs with a P-256 PKCS#8 key held in this process.
 *
 * @remarks This file-backed option is suitable when the host protects the key file; `P256Signer` remains the seam for
 * a vault or HSM that never releases key material.
 */
export class PemP256Signer implements P256Signer {
  readonly #privateKey: CryptoKey;
  private constructor(
    private readonly publicKey: CryptoKey,
    privateKey: CryptoKey,
  ) {
    this.#privateKey = privateKey;
  }

  /** Imports a PKCS#8 PEM key and refuses other curves at load time, before a partner receives an avoidable refusal. */
  static async fromPem(pem: string): Promise<PemP256Signer> {
    if (typeof pem !== 'string') throw new PrivateKeyError('The private key must be supplied as PEM text.');
    const normalized = pem.replace(/^\uFEFF/, '').trim();
    if (normalized.includes('-----BEGIN ENCRYPTED PRIVATE KEY-----'))
      throw new PrivateKeyError('Encrypted PEM keys are not supported; decrypt the key before loading it.');
    if (normalized.includes('-----BEGIN EC PRIVATE KEY-----'))
      throw new PrivateKeyError('SEC1 PEM keys are not supported; convert to PKCS#8 before loading the key.');
    const match = /-----BEGIN PRIVATE KEY-----\s*([A-Za-z0-9+/=\r\n]+)\s*-----END PRIVATE KEY-----/.exec(normalized);
    if (!match?.[1]) throw new PrivateKeyError('Expected a PKCS#8 PEM block labeled PRIVATE KEY.');
    const pkcs8 = Buffer.from(match[1].replace(/\s/g, ''), 'base64');
    try {
      const extractableKey = await globalThis.crypto.subtle.importKey(
        'pkcs8',
        pkcs8,
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign'],
      );
      const jwk = await globalThis.crypto.subtle.exportKey('jwk', extractableKey);
      if (!jwk.x || !jwk.y) throw new PrivateKeyError('The private key did not export public coordinates.');
      const publicKey = await globalThis.crypto.subtle.importKey(
        'jwk',
        { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true },
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['verify'],
      );
      const privateKey = await globalThis.crypto.subtle.importKey(
        'pkcs8',
        pkcs8,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign'],
      );
      return new PemP256Signer(publicKey, privateKey);
    } catch (cause) {
      throw new PrivateKeyError('The PEM key must be a valid ECDSA P-256 PKCS#8 private key.', { cause });
    } finally {
      pkcs8.fill(0);
    }
  }

  /** Reads and imports a protected PKCS#8 PEM file so the private key can remain in host-controlled storage. */
  static async fromPemFile(path: string): Promise<PemP256Signer> {
    try {
      return await this.fromPem(await readFile(path, 'utf8'));
    } catch (cause) {
      if (cause instanceof PrivateKeyError) throw cause;
      throw new PrivateKeyError('The PEM key file could not be read.', { cause });
    }
  }
  /** Signs bytes in WebCrypto's 64-byte P1363 form; no DER conversion can silently change the wire signature. */
  async sign(data: Uint8Array): Promise<Uint8Array> {
    try {
      return new Uint8Array(
        await globalThis.crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.#privateKey, arrayBufferOf(data)),
      );
    } catch (cause) {
      throw new PrivateKeyError('The in-memory P-256 private key could not sign the request.', { cause });
    }
  }
  /** Exports only public coordinates for enrollment and verification; the private half is never part of the JWK. */
  async publicJwk(): Promise<PartnerJwk> {
    try {
      const jwk = await globalThis.crypto.subtle.exportKey('jwk', this.publicKey);
      return {
        kty: 'EC',
        crv: 'P-256',
        ...(jwk.x === undefined ? {} : { x: jwk.x }),
        ...(jwk.y === undefined ? {} : { y: jwk.y }),
      };
    } catch (cause) {
      throw new PrivateKeyError('The P-256 public key could not be exported.', { cause });
    }
  }
  /** Binds this key to the issued credential UUID used by Anis to resolve request signatures. */
  forKey(keyId: string): KeyedSigner {
    return new KeyedSigner(this, keyId);
  }
}
