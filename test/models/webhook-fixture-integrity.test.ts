import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const directory = fileURLToPath(new URL('./fixtures/webhooks/', import.meta.url));
const checksums = JSON.parse(readFileSync(join(directory, 'SHA256SUMS.json'), 'utf8')) as Record<string, string>;

function filesIn(path: string, prefix = ''): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix + entry.name;
    return entry.isDirectory() ? filesIn(join(path, entry.name), relative + '/') : [relative];
  });
}

describe('canonical webhook fixture bytes', () => {
  it('contains the complete owner folder and no stale or untracked fixture files', () => {
    expect(Object.keys(checksums)).toHaveLength(37);
    expect(filesIn(directory).sort()).toEqual([...Object.keys(checksums), 'SHA256SUMS.json'].sort());
  });
  it.each(Object.entries(checksums))('matches the owner SHA-256 for %s', (file, expected) => {
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
    expect(
      createHash('sha256')
        .update(readFileSync(join(directory, file)))
        .digest('hex'),
    ).toBe(expected);
  });
});
