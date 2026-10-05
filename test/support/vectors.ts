import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Reads vector files from their checked-in suite folder. */
export function vectorFiles(folder: string, prefix: string): string[] {
  const directory = join(process.cwd(), 'test', 'vectors', folder);
  return readdirSync(directory)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .sort()
    .map((name) => join(directory, name));
}

/** Parses a JSON fixture into the explicitly selected fixture shape. */
export function readVector<T>(path: string, decode: (value: unknown) => T): T {
  return decode(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}

/** Uses each fixture ID as the individual parameterized test name. */
export function vectorId(path: string): string {
  return readVector(path, (value) => (value as { id: string }).id);
}
