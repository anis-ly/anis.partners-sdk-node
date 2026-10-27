import { randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Creates and syncs an exclusive intent before any network send. */
export async function createJournal(path: string, contents: string): Promise<void> {
  const journal = await open(path, 'wx', 0o600);
  try {
    await journal.writeFile(contents, 'utf8');
    await journal.sync();
  } catch (error) {
    await journal.close();
    await unlink(path).catch(() => undefined);
    throw error;
  }
  await journal.close();
}

const journalLocks = new Map<string, Promise<void>>();

/** Serializes same-process updates and preserves completed outcomes against late unresolved answers. */
export async function updateJournal(path: string, candidate: Record<string, unknown>): Promise<void> {
  await withJournalLock(path, async () => {
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
      const current = await readJournal(path);
      const merged = mergeJournal(current, candidate);
      const temporary = await open(temporaryPath, 'wx', 0o600);
      try {
        await temporary.writeFile(JSON.stringify(merged, null, 2), 'utf8');
        await temporary.sync();
      } finally {
        await temporary.close();
      }
      const latest = await readJournal(path);
      const finalJournal = mergeJournal(latest, candidate);
      const replacement = await open(temporaryPath, 'w', 0o600);
      try {
        await replacement.writeFile(JSON.stringify(finalJournal, null, 2), 'utf8');
        await replacement.sync();
      } finally {
        await replacement.close();
      }
      await rename(temporaryPath, path);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  });
}

async function readJournal(path: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new TypeError('The order journal must contain a JSON object.');
  return parsed as Record<string, unknown>;
}

async function withJournalLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const key = resolve(path);
  const previous = journalLocks.get(key) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const tail = previous.then(() => gate);
  journalLocks.set(key, tail);
  await previous;
  try {
    return await action();
  } finally {
    release?.();
    if (journalLocks.get(key) === tail) journalLocks.delete(key);
  }
}

function mergeJournal(current: Record<string, unknown>, candidate: Record<string, unknown>): Record<string, unknown> {
  const currentResult = asJournalObject(current.result);
  const candidateResult = asJournalObject(candidate.result);
  if (candidateResult === undefined) return { ...current, ...candidate };
  const keepCompleted =
    ['completed', 'final', 'notPlaced'].includes(String(currentResult?.kind)) &&
    ['processing', 'unknown', 'replayed'].includes(String(candidateResult.kind));
  const selectedResult = keepCompleted ? currentResult : candidateResult;
  const existingCredentials = isUnknownArray(currentResult?.credentials) ? currentResult.credentials : [];
  const suppliedCredentials = isUnknownArray(candidateResult.credentials) ? candidateResult.credentials : [];
  const credentials = [...existingCredentials, ...suppliedCredentials];
  const result = credentials.length === 0 ? selectedResult : { ...selectedResult, credentials };
  return { ...current, ...candidate, result };
}

function asJournalObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}
