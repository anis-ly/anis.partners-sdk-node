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
    const jsonStart = output.indexOf('[\n  {');
    expect(jsonStart).toBeGreaterThanOrEqual(0);
    const packed = JSON.parse(output.slice(jsonStart)) as { files: { path: string }[] }[];
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
  });
});
