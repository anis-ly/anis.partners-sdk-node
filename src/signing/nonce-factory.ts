import { randomBytes } from 'node:crypto';
import { encodeBase64Url } from '../internal/base64url.js';

/** Creates the single-use nonce that protects a mutation from replay. */
export interface NonceFactory {
  /** Returns 128 random bits in unpadded base64url; repeated or guessable values are refused as replays. */
  create(): string;
}

/** Uses the operating system cryptographic random source for every mutation attempt. */
export class RandomNonceFactory implements NonceFactory {
  /** Generates a fresh 16-byte nonce so retries do not reuse a replayable request value. */
  create(): string {
    return encodeBase64Url(randomBytes(16));
  }
}
