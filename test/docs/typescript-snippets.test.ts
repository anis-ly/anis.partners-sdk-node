import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

interface Snippet {
  label: string;
  source: string;
}

const root = process.cwd();
const snippets = await readDocumentationSnippets();

describe('published TypeScript documentation', () => {
  it.each(snippets)('$label TypeScript block has valid syntax', ({ label, source }) => {
    const result = ts.transpileModule(source, {
      fileName: `${label}.ts`,
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
    });
    const errors = (result.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    );

    expect(errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  });
});

async function readDocumentationSnippets(): Promise<Snippet[]> {
  const paths = [join(root, 'README.md')];
  const docs = await readdir(join(root, 'docs'));
  paths.push(...docs.filter((path) => path.endsWith('.md')).map((path) => join(root, 'docs', path)));

  const results: Snippet[] = [];
  for (const path of paths) {
    const text = await readFile(path, 'utf8');
    const pattern = /```(?:ts|typescript)[^\S\r\n]*\r?\n([\s\S]*?)```/g;
    for (const match of text.matchAll(pattern)) {
      const source = match[1];
      if (source === undefined) continue;
      const line = text.slice(0, match.index).split('\n').length;
      results.push({ label: `${path.replace(`${root}/`, '')}:${String(line)}`, source });
    }
  }
  return results;
}
