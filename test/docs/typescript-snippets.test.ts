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
  it.each(snippets)('$label TypeScript block parses and type-checks', ({ label, source }) => {
    const index = snippets.findIndex((snippet) => snippet.label === label && snippet.source === source);
    const virtualFile = join(root, 'test', `__docs-${String(index)}.ts`);
    const context =
      label.startsWith('docs/getting-started.md') && source.includes('const profile = await client.profile.get();')
        ? "import type { AnisPartnersClient } from '@anis-ly/partners';\ndeclare const client: AnisPartnersClient;\n"
        : '';
    const checkedSource = `${context}${source}`;
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2023,
      lib: ['lib.es2023.d.ts', 'lib.dom.d.ts'],
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      noEmit: true,
      skipLibCheck: true,
      types: ['node'],
    };
    const host = ts.createCompilerHost(options);
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
      fileName === virtualFile
        ? ts.createSourceFile(fileName, checkedSource, languageVersion, true)
        : getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    const fileExists = host.fileExists.bind(host);
    host.fileExists = (fileName) => fileName === virtualFile || fileExists(fileName);
    const readFile = host.readFile.bind(host);
    host.readFile = (fileName) => (fileName === virtualFile ? checkedSource : readFile(fileName));
    const program = ts.createProgram([virtualFile], options, host);
    const errors = ts
      .getPreEmitDiagnostics(program)
      .filter(
        (diagnostic) =>
          diagnostic.category === ts.DiagnosticCategory.Error &&
          diagnostic.file?.fileName === virtualFile &&
          !(diagnostic.code === 2307 && isOptionalOpenTelemetryModule(diagnostic)),
      );

    expect(errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  });
});

function isOptionalOpenTelemetryModule(diagnostic: ts.Diagnostic): boolean {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  return [
    '@opentelemetry/sdk-node',
    '@opentelemetry/exporter-metrics-otlp-proto',
    '@opentelemetry/exporter-trace-otlp-proto',
    '@opentelemetry/sdk-metrics',
  ].some((moduleName) => message.includes(moduleName));
}

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
