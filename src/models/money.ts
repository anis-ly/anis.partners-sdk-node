import { asObject, optionalTimestamp, requiredString } from './model-parsing.js';

/**
 * An exact currency amount stored as thousandths instead of floating-point units.
 *
 * @remarks The contract sends amounts as decimal strings because a floating-point round trip can change the total
 * checked against unit price multiplied by quantity. Integer thousandths keep that comparison exact.
 */
export class Money {
  private constructor(
    private readonly thousandths: bigint,
    /** ISO currency code associated with this amount. */
    readonly currency: string,
    /** Instant at which the amount was computed, when the wire provides one. */
    readonly asOf?: Date,
  ) {}

  /**
   * Builds an amount from its decimal wire spelling.
   *
   * @remarks A number has already passed through floating-point arithmetic, so accepting one could make an order
   * total differ from the exact unit price the API checks.
   */
  static of(amount: string, currency: string, asOf?: Date): Money {
    if (typeof amount !== 'string') {
      throw new TypeError('Money amounts must be decimal strings.');
    }
    if (typeof currency !== 'string' || currency.length === 0) {
      throw new TypeError('A currency code is required.');
    }
    const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/.exec(amount);
    if (match === null) {
      throw new TypeError('A money amount must be a decimal string.');
    }
    const sign = match[1] === '-' ? -1n : 1n;
    const whole = BigInt(match[2] ?? '0');
    const fraction = match[3] ?? '';
    if (fraction.length > 3) {
      throw new TypeError('Anis amounts have at most three decimal places');
    }
    const thousandths = whole * 1000n + BigInt((fraction + '000').slice(0, 3));
    return new Money(sign * thousandths, currency, asOf);
  }

  /** The amount rendered with exactly three decimal places so Anis receives the contract's decimal-string form. */
  get amount(): string {
    const negative = this.thousandths < 0n;
    const absolute = negative ? -this.thousandths : this.thousandths;
    const whole = absolute / 1000n;
    const fraction = String(absolute % 1000n).padStart(3, '0');
    return `${negative ? '-' : ''}${String(whole)}.${fraction}`;
  }

  /**
   * Multiplies by a whole quantity without losing fractional currency units.
   *
   * @remarks The source instant describes the unit quote, not the computed order total, so it is cleared on the result.
   */
  multiply(quantity: number): Money {
    if (!Number.isSafeInteger(quantity)) {
      throw new TypeError('Money can only be multiplied by a safe whole number.');
    }
    return new Money(this.thousandths * BigInt(quantity), this.currency);
  }

  /** Converts to the contract object while retaining its decimal-string amount. */
  toJSON(): { amount: string; currency: string; asOf?: string } {
    return {
      amount: this.amount,
      currency: this.currency,
      ...(this.asOf === undefined ? {} : { asOf: timestampToWire(this.asOf) }),
    };
  }
}

/** Parses the contract object and refuses JSON numbers for amounts. */
export function parseMoney(json: unknown): Money {
  const object = asObject(json, 'Money');
  const amount = requiredString(object, 'amount', 'Money');
  const currency = requiredString(object, 'currency', 'Money');
  const asOf = optionalTimestamp(object, 'asOf', 'Money');
  return Money.of(amount, currency, asOf);
}

function timestampToWire(value: Date): string {
  if (Number.isNaN(value.getTime())) {
    throw new TypeError('Money.asOf must be a valid date.');
  }
  return value.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
