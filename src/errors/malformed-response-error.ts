import { AnisPartnersError } from './anis-partners-error.js';

/** A signed answer violated a model contract; its content is deliberately absent from the message and cause. */
export class MalformedResponseError extends AnisPartnersError {
  readonly model: string;

  constructor(model: string) {
    super(`The verified Anis response did not match the ${model} contract.`);
    this.model = model;
  }
}
