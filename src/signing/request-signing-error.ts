import { AnisPartnersError } from '../errors/anis-partners-error.js';

/** Indicates signing failed before a request was sent, so the partner can safely distinguish it from a server outcome. */
export class RequestSigningError extends AnisPartnersError {
  /** Preserves the original signer failure as `cause` while keeping sensitive signature material out of the message. */
  constructor(cause: unknown) {
    super('The request could not be signed and was not sent.', { cause });
  }
}
