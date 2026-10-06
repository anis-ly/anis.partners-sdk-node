const errorBrandPrefix = '@anis-ly/partners.error:';

/** Base type for failures raised by this SDK, so applications can handle local faults separately from HTTP refusals. */
export class AnisPartnersError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    let prototype: object = new.target.prototype;
    while (prototype !== Error.prototype && prototype !== Object.prototype) {
      const constructorName = (prototype.constructor as { name?: string }).name ?? 'AnisPartnersError';
      Object.defineProperty(this, Symbol.for(`${errorBrandPrefix}${constructorName}`), { value: true });
      const parent = Object.getPrototypeOf(prototype) as object | null;
      if (parent === null) break;
      prototype = parent;
    }
    this.name = new.target.name;
  }

  static override [Symbol.hasInstance](value: unknown): boolean {
    if (typeof value !== 'object' || value === null) return false;
    return (value as Record<symbol, unknown>)[Symbol.for(`${errorBrandPrefix}${this.name}`)] === true;
  }

  [inspect.custom](): string {
    return `${this.name}: ${this.message}`;
  }
}
import { inspect } from 'node:util';
