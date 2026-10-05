import { readFile } from 'node:fs/promises';
import { KeyedSigner } from './keyed-signer.js';
import type { P256Signer } from './p256-signer.js';
import type { PartnerJwk } from '../verification/partner-jwk.js';
import { arrayBufferOf } from '../internal/bytes.js';

/**
 * Signs with a P-256 PKCS#8 key held in this process.
 *
 * @remarks This file-backed option is suitable when the host protects the key file; `P256Signer` remains the seam for
 * a vault or HSM that never releases key material.
 */
export class PemP256Signer implements P256Signer {
  private constructor(
    private readonly privateKey: CryptoKey,
    private readonly publicKey: CryptoKey,
  ) {}

  /** Imports a PKCS#8 PEM key and refuses other curves at load time, before a partner receives an avoidable refusal. */
  static async fromPem(pem: string): Promise<PemP256Signer> {
    const match = /^-----BEGIN PRIVATE KEY-----\s*([A-Za-z0-9+/=\r\n]+)\s*-----END PRIVATE KEY-----\s*$/.exec(pem);
    if (!match?.[1]) throw new Error('Expected a PKCS#8 PEM block labeled PRIVATE KEY.');
    try {
      const privateKey = await globalThis.crypto.subtle.importKey(
        'pkcs8',
        Buffer.from(match[1].replace(/\s/g, ''), 'base64'),
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign'],
      );
      const jwk = await globalThis.crypto.subtle.exportKey('jwk', privateKey);
      if (!jwk.x || !jwk.y) throw new Error('The private key did not export public coordinates.');
      const publicKey = await globalThis.crypto.subtle.importKey(
        'jwk',
        { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true },
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['verify'],
      );
      return new PemP256Signer(privateKey, publicKey);
    } catch (cause) {
      throw new Error('The PEM key must be a valid ECDSA P-256 PKCS#8 private key.', { cause });
    }
  }

  /** Reads and imports a protected PKCS#8 PEM file so the private key can remain in host-controlled storage. */
  static async fromPemFile(path: string): Promise<PemP256Signer> {
    return this.fromPem(await readFile(path, 'utf8'));
  }
  /** Signs bytes in WebCrypto's 64-byte P1363 form; no DER conversion can silently change the wire signature. */
  async sign(data: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(
      await globalThis.crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.privateKey, arrayBufferOf(data)),
    );
  }
  /** Exports only public coordinates for enrollment and verification; the private half is never part of the JWK. */
  async publicJwk(): Promise<PartnerJwk> {
    const jwk = await globalThis.crypto.subtle.exportKey('jwk', this.publicKey);
    return {
      kty: 'EC',
      crv: 'P-256',
      ...(jwk.x === undefined ? {} : { x: jwk.x }),
      ...(jwk.y === undefined ? {} : { y: jwk.y }),
    };
  }
  /** Binds this key to the issued credential UUID used by Anis to resolve request signatures. */
  forKey(keyId: string): KeyedSigner {
    return new KeyedSigner(this, keyId);
  }
}
