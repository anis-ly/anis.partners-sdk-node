import { readFileSync } from 'node:fs';

/** Reads a vendored public fixture without depending on the planning repository. */
export function publicFixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/webhooks/${name}/public-read.json`, import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
}
/** Reads a vendored event envelope. */
export function envelopeFixture(name: string): Record<string, unknown> | null {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/webhooks/${name}/envelope.json`, import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
}
/** Reads a vendored collection fixture. */
export function listFixture(name: 'meter-charges' | 'direct-recharges'): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`./fixtures/lists/${name}.json`, import.meta.url), 'utf8')) as Record<
    string,
    unknown
  >;
}
