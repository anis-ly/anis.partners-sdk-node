import { describe, expect, it } from 'vitest';
import { inspect } from 'node:util';
import { Money, parseMoney } from '../../src/models/money.js';

describe('Money', () => {
  it('parses and writes amounts with exactly three places', () => {
    const money = parseMoney({ amount: '10.500', currency: 'LYD', asOf: '2026-09-19T08:00:00.999Z' });

    expect(money.amount).toBe('10.500');
    expect(money.toJSON()).toEqual({ amount: '10.500', currency: 'LYD', asOf: '2026-09-19T08:00:00Z' });
  });

  it('pads an amount with fewer than three decimal places', () => {
    expect(Money.of('10.5', 'LYD').amount).toBe('10.500');
  });

  it('refuses a JSON number for an amount', () => {
    expect(() => parseMoney({ amount: 10.5, currency: 'LYD' })).toThrow(TypeError);
  });

  it('refuses a floating-point argument when constructing money', () => {
    // @ts-expect-error Money.of deliberately refuses JavaScript numbers.
    expect(() => Money.of(10.5, 'LYD')).toThrow(TypeError);
  });

  it('multiplies exactly using integer thousandths', () => {
    expect(Money.of('10.125', 'LYD').multiply(3).amount).toBe('30.375');
  });

  it('renders a decimal balance with its currency in application text', () => {
    const amount = Money.of('10.500', 'LYD');

    expect(String(amount)).toBe('10.500 LYD');
    expect(inspect(amount)).toBe('10.500 LYD');
  });

  it('refuses an amount with more than three decimal places', () => {
    expect(() => Money.of('0.0004', 'LYD')).toThrow('Anis amounts have at most three decimal places');
  });

  it('refuses an over-precise amount read from the wire', () => {
    expect(() => parseMoney({ amount: '0.0004', currency: 'LYD' })).toThrow(
      'Money.amount must be a decimal string with exactly three decimal places.',
    );
  });

  it('holds a negative amount, as a wallet balance in allowed debt is', () => {
    const balance = Money.of('-150.5', 'LYD');

    expect(balance.amount).toBe('-150.500');
    expect(Money.of('-0.001', 'LYD').amount).toBe('-0.001');
    expect(String(balance)).toBe('-150.500 LYD');
  });
});

describe('v2 money wire rules', () => {
  it.each(['1', '1.2', '-1', '+1.000', '--1.000', '1.0000', '-1.0000'])('refuses amount %s on the wire', (amount) => {
    expect(() => parseMoney({ amount, currency: 'LYD' })).toThrow(TypeError);
  });
  it('reads a negative wallet balance from the wire', () => {
    const balance = parseMoney({ amount: '-1250.075', currency: 'LYD', asOf: '2026-10-14T08:00:00Z' });

    expect(balance.amount).toBe('-1250.075');
    expect(balance.toJSON()).toEqual({ amount: '-1250.075', currency: 'LYD', asOf: '2026-10-14T08:00:00Z' });
  });
  it('reads negative zero from the wire as zero', () => {
    expect(parseMoney({ amount: '-0.000', currency: 'LYD' }).amount).toBe('0.000');
  });
  it.each(['lyd', 'LY', 'LYDD', '123'])('refuses currency %s', (currency) => {
    expect(() => Money.of('1.000', currency)).toThrow(TypeError);
  });
  it('refuses multiplication that produces a negative amount', () => {
    expect(() => Money.of('1.000', 'LYD').multiply(-1)).toThrow(TypeError);
  });
});
