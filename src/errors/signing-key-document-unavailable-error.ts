import { AnisPartnersError } from './anis-partners-error.js';

/** The public signing-key document could not be loaded, so the response has no usable verification key set. */
export class SigningKeyDocumentUnavailableError extends AnisPartnersError {
  constructor() {
    super('The Anis signing-key document could not be loaded.');
  }
}
