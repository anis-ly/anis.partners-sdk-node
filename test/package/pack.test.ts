import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('npm package contents', () => {
  it('builds before packing and includes the supported entry points and license files', async () => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: { prepack?: string };
    };
    expect(packageJson.scripts.prepack).toBe('npm run build');

    const cachePath = await mkdtemp(join(tmpdir(), 'anis-npm-pack-'));
    let output: string;
    try {
      output = execFileSync('npm', ['pack', '--dry-run', '--json', '--cache', cachePath], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } finally {
      await rm(cachePath, { recursive: true, force: true });
    }
    const packed = parsePackOutput(output);
    const files = new Set(packed[0]?.files.map((file) => file.path));

    for (const required of [
      'dist/index.js',
      'dist/index.cjs',
      'dist/index.d.ts',
      'dist/index.d.cts',
      'README.md',
      'LICENSE',
    ]) {
      expect(files.has(required), `${required} is included in the npm package`).toBe(true);
    }
    expect([...files].some((path) => path.startsWith('docs/'))).toBe(false);
    expect([...files].some((path) => path.startsWith('samples/'))).toBe(false);
    expect([...files].some((path) => path.startsWith('src/'))).toBe(false);
    expect([...files].some((path) => path.startsWith('test/'))).toBe(false);
  });
});

function parsePackOutput(output: string): { files: { path: string }[] }[] {
  const start = output.indexOf('[');
  if (start < 0) throw new SyntaxError('npm pack did not print its JSON file list.');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < output.length; index += 1) {
    const character = output[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (character === '[') depth += 1;
    if (character === ']') depth -= 1;
    if (depth === 0) {
      return JSON.parse(output.slice(start, index + 1)) as { files: { path: string }[] }[];
    }
  }
  throw new SyntaxError('npm pack printed an incomplete JSON file list.');
}
