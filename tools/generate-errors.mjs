import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

/** @typedef {{ publicDocumentation?: boolean; publicCode: string; retryable?: boolean }} ErrorRepresentation */
/** @typedef {{ representations: ErrorRepresentation[] }} ErrorCatalogue */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cataloguePath = resolve(root, 'contracts/error-catalogue.json');
const outputPath = resolve(root, 'src/errors/error-codes.generated.ts');

/**
 * Generate TypeScript error constants from the catalogue's public representations.
 * @param {ErrorCatalogue} catalogue - Catalogue data read from the vendored contract.
 */
export function renderErrorCodes(catalogue) {
  const representations = catalogue.representations
    .filter((entry) => entry.publicDocumentation === true)
    .sort((left, right) => (left.publicCode < right.publicCode ? -1 : left.publicCode > right.publicCode ? 1 : 0));
  /** @type {Map<string, ErrorRepresentation>} */
  const unique = new Map();
  for (const entry of representations) {
    if (!unique.has(entry.publicCode)) {
      unique.set(entry.publicCode, entry);
    }
  }
  const codes = [...unique.keys()].sort();
  const retryable = [...unique.values()]
    .filter((entry) => entry.retryable === true)
    .map((entry) => entry.publicCode)
    .sort();
  const codeLines = codes.map((code) => `  '${code}',`);
  const retryableLines = retryable.map((code) => `  '${code}',`);

  return [
    '// This file is generated from contracts/error-catalogue.json by tools/generate-errors.mjs.',
    '// Do not edit it directly; run npm run generate:errors.',
    '',
    '/** Every published error code this SDK version recognizes. */',
    'export const ERROR_CODES = [',
    ...codeLines,
    '] as const;',
    '',
    '/** A published error code, or unknown when Anis adds one this SDK has not seen yet. */',
    "export type ErrorCode = (typeof ERROR_CODES)[number] | 'unknown';",
    '',
    '/** Codes the public catalogue marks as retryable. Unknown codes are never assumed to be retryable. */',
    'export const RETRYABLE_ERROR_CODES: ReadonlySet<ErrorCode> = new Set([',
    ...retryableLines,
    ']);',
    '',
    '/** Resolves a wire code, retaining forward compatibility when Anis publishes a new code. */',
    'export function parseErrorCode(code: string | null | undefined): ErrorCode {',
    '  if (code === null || code === undefined) {',
    "    return 'unknown';",
    '  }',
    "  return ERROR_CODES.find((known) => known === code) ?? 'unknown';",
    '}',
    '',
  ].join('\n');
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  /** @type {unknown} */
  const parsed = JSON.parse(await readFile(cataloguePath, 'utf8'));
  if (!isErrorCatalogue(parsed)) {
    throw new TypeError('The error catalogue does not have the expected public representation shape.');
  }
  const catalogue = parsed;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderErrorCodes(catalogue));
  process.stdout.write(
    `generated ${String(catalogue.representations.filter((entry) => entry.publicDocumentation === true).length)} public representations -> src/errors/error-codes.generated.ts\n`,
  );
}

/** @param {unknown} value @returns {value is ErrorCatalogue} */
function isErrorCatalogue(value) {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('representations' in value) ||
    !Array.isArray(value.representations)
  ) {
    return false;
  }
  /** @type {unknown[]} */
  const representations = value.representations;
  return representations.every(isErrorRepresentation);
}

/** @param {unknown} value @returns {value is ErrorRepresentation} */
function isErrorRepresentation(value) {
  if (typeof value !== 'object' || value === null || !('publicCode' in value) || typeof value.publicCode !== 'string') {
    return false;
  }
  return !('publicDocumentation' in value) || typeof value.publicDocumentation === 'boolean';
}
