import { describe, expect, it } from 'vitest';
import { inspect } from 'node:util';
import { Money, parseMoney } from '../../src/models/money.js';

describe('Money', () => {
  it('parses and writes amounts with exactly three places', () => {
    const money = parseMoney({ amount: '10.5', currency: 'LYD', asOf: '2026-09-19T08:00:00.999Z' });

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
      'Anis amounts have at most three decimal places',
    );
  });

  it('keeps negative thousandths exact for the order price guard', () => {
    expect(Money.of('-0.001', 'LYD').amount).toBe('-0.001');
  });
});
