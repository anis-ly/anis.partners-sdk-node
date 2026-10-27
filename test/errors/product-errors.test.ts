import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AnisApiError, createAnisApiError } from '../../src/errors/anis-api-error.js';
import { ERROR_CODES, parseErrorCode, RETRYABLE_ERROR_CODES } from '../../src/errors/error-codes.generated.js';

const errors = [
  {
    code: 'meter_rejected',
    status: 422,
    guidance: 'Correct the meter number and use a new Idempotency-Key for a new attempt.',
  },
  { code: 'package_unavailable', status: 409, guidance: 'Choose an available package and use a new Idempotency-Key.' },
  {
    code: 'direct_recharge_product_unavailable',
    status: 409,
    guidance: 'Choose an available transfer priced for this wallet tier.',
  },
  { code: 'amount_out_of_range', status: 422, guidance: 'Choose an amount within the quoted limits.' },
  {
    code: 'direct_recharge_not_suspended',
    status: 409,
    guidance: 'Read the direct recharge; recipient changes require suspendedDataError.',
  },
  {
    code: 'webhook_endpoint_invalid',
    status: 422,
    guidance: 'Use HTTPS on port 443 with a host name, no user-info or fragment, and at most 2048 characters.',
  },
  {
    code: 'webhook_endpoint_unverified',
    status: 409,
    guidance: 'Set an endpoint and complete its verification before testing or redelivering.',
  },
];

describe('product error representations', () => {
  it.each(errors)('recognizes $code as a nonretryable base API error and preserves headers', ({ code, status }) => {
    const error = createAnisApiError(
      JSON.stringify({
        code,
        status,
        type: `https://developers.anis.ly/errors/${code.replaceAll('_', '-')}`,
        requestId: 'req-product',
      }),
      status,
      new Headers({ 'Retry-After': '7', 'Idempotency-Replayed': 'true' }),
    );
    expect(error.constructor).toBe(AnisApiError);
    expect(error).toMatchObject({
      code,
      rawCode: code,
      status,
      requestId: 'req-product',
      retryAfter: 7,
      isReplayed: true,
      isRetryable: false,
    });
    expect(parseErrorCode(code)).toBe(code);
    expect(RETRYABLE_ERROR_CODES.has(parseErrorCode(code))).toBe(false);
  });
  it('retains the exact seven published design rows and both purchase_not_allowed representations', () => {
    const catalogue = JSON.parse(
      readFileSync(new URL('../../contracts/error-catalogue.json', import.meta.url), 'utf8'),
    ) as { representations: { publicCode: string; httpStatus: number }[] };
    // 39 baseline codes + 7 product codes + 2 network codes known to the generator.
    expect(ERROR_CODES).toHaveLength(48);
    for (const { code, status, guidance } of errors)
      expect(catalogue.representations.find((entry) => entry.publicCode === code)).toEqual({
        publicCode: code,
        httpStatus: status,
        retryable: false,
        type: `https://developers.anis.ly/errors/${code.replaceAll('_', '-')}`,
        retryGuidance: guidance,
        publicDocumentation: true,
      });
    expect(
      catalogue.representations
        .filter((entry) => entry.publicCode === 'purchase_not_allowed')
        .map((entry) => entry.httpStatus),
    ).toEqual([403, 409]);
  });
  it.each([
    undefined,
    {},
    { other: true },
    { fields: 'bad shape' },
    { fields: { recipient_number: 'رقم غير صحيح', Unknown: 42 }, other: { a: true } },
  ])('keeps raw validation extensions available without assuming fields shape: %j', (extensions) => {
    const error = createAnisApiError(JSON.stringify({ status: 422, code: 'validation_failed', extensions }), 422);
    expect(error.problem.extensions).toEqual(extensions);
    expect(JSON.stringify(error)).not.toContain('رقم غير صحيح');
  });
});
