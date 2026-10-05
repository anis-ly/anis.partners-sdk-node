import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderErrorCodes } from '../../tools/generate-errors.mjs';

describe('generated error catalogue', () => {
  it('matches the exact output produced from the published error catalogue', async () => {
    const root = process.cwd();
    const catalogue = JSON.parse(await readFile(resolve(root, 'contracts/error-catalogue.json'), 'utf8')) as unknown;
    const generated = await readFile(resolve(root, 'src/errors/error-codes.generated.ts'), 'utf8');

    expect(renderErrorCodes(catalogue as Parameters<typeof renderErrorCodes>[0])).toBe(generated);
  });
});
