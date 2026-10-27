import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PartnerWebhookVerifier } from '../../src/verification/partner-webhook-verifier.js';
import { PartnerWebhookSignatureBase } from '../../src/verification/partner-webhook-signature-base.js';
import { parseWebhookSignatureInput } from '../../src/verification/webhook-signature-input-parser.js';
import type { SigningKeySet } from '../../src/verification/partner-jwk.js';
import { UnverifiableWebhookError } from '../../src/verification/unverifiable-webhook-error.js';
import type { VerifiableWebhook, WebhookReceiverOptions } from '../../src/verification/verifiable-webhook.js';
import {
  WEBHOOK_VERIFICATION_FAILURES,
  type WebhookVerificationFailure,
} from '../../src/verification/webhook-verification-failure.js';
import { readVector, vectorFiles, vectorId } from '../support/vectors.js';

interface WebhookVector {
  id: string;
  title: string;
  route: string;
  profile: string;
  verifyAt: number;
  receiver: WebhookReceiverOptions;
  request: { method: string; targetUri: string; headers: Record<string, string>; bodyBase64: string };
  signingKeys: SigningKeySet;
  signatureBaseForDebugging: string;
  expected: {
    outcome: 'accept' | 'reject';
    reason: WebhookVerificationFailure | null;
    phase?: 'verify' | 'parse';
    envelope?: { id: string; type: string; applicationId: string };
  };
}
interface ManifestEntry {
  file?: string;
  id: string;
  title: string;
  route: string;
  outcome: 'accept' | 'reject';
  reason: WebhookVerificationFailure | null;
  phase?: 'verify' | 'parse';
}
interface WebhookManifest {
  productionSource: { sha256: string };
  profile: string;
  algorithm: string;
  label: string;
  skewSeconds: number;
  lifetimeSeconds: number;
  total: number;
  accept: number;
  reject: number;
  vectors: ManifestEntry[];
}
const directory = join(process.cwd(), 'test', 'vectors', 'webhook');
const manifestPath = join(directory, 'manifest.json');
// A missing upstream corpus is a failing dependency, never an empty or skipped conformance suite.
if (!existsSync(manifestPath))
  throw new Error(
    'Webhook conformance corpus is missing test/vectors/webhook/manifest.json. Vendor the D80 corpus byte-identically.',
  );
const manifest = readVector(manifestPath, (value) => value as WebhookManifest);
const files = vectorFiles('webhook', 'WH-');
if (files.length === 0) throw new Error('The webhook conformance manifest must contain at least one vector.');

function decodeBody(encoded: string): Uint8Array {
  if (typeof encoded !== 'string') throw new TypeError('Webhook vectors require bodyBase64 bytes.');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw new TypeError('Webhook bodyBase64 must be canonical base64.');
  return new Uint8Array(bytes);
}

describe('webhook verification vectors', () => {
  it('pins the refreshed owner corpus and signer provenance', () => {
    const names = readdirSync(directory)
      .filter((name) => name.endsWith('.json'))
      .sort();
    expect(names).toHaveLength(76);
    const listing = names
      .map(
        (name) =>
          `${createHash('sha256')
            .update(readFileSync(join(directory, name)))
            .digest('hex')}  ${name}\n`,
      )
      .join('');
    expect(createHash('sha256').update(listing).digest('hex')).toBe(
      'a598d6a274516bc28e4afadf40978048a99bea0f604d84140229494739fc3cfa',
    );
    expect(createHash('sha256').update(readFileSync(manifestPath)).digest('hex')).toBe(
      'ac415a95f46702a77b40a74a927b723c663759e5734e65e8c0b5af1c98909272',
    );
    expect(manifest.productionSource.sha256).toBe('e20d0397574b9213909a28f328d2da76ec5c3d1e85ac6ba958197e0f9905efe3');
    expect(manifest).toMatchObject({ total: 75, accept: 20, reject: 55 });
  });
  it('contains a complete, unique, nonempty manifest matching every vector on disk', () => {
    expect(manifest).toMatchObject({
      profile: 'anis-partner-webhook-v1',
      algorithm: 'ecdsa-p256-sha256',
      label: 'sig1',
      skewSeconds: 300,
      lifetimeSeconds: 300,
    });
    expect(manifest.total).toBeGreaterThan(0);
    expect(manifest.accept).toBeGreaterThan(0);
    expect(manifest.reject).toBeGreaterThan(0);
    expect(files).toHaveLength(manifest.total);
    expect(manifest.vectors).toHaveLength(manifest.total);
    const disk = readdirSync(directory)
      .filter((name) => name !== 'manifest.json')
      .sort();
    const indexed = manifest.vectors.map((entry) => entry.file ?? `${entry.id}.json`).sort();
    expect(indexed.every((name) => /^WH-[^/\\]+\.json$/.test(name))).toBe(true);
    expect(indexed).toEqual(disk);
    expect(new Set(indexed).size).toBe(indexed.length);
    expect(new Set(manifest.vectors.map((entry) => entry.id)).size).toBe(manifest.total);
    const vectors = files.map((path) => readVector(path, (value) => value as WebhookVector));
    expect(new Set(vectors.map((vector) => vector.id)).size).toBe(manifest.total);
    expect(vectors.filter((vector) => vector.expected.outcome === 'accept')).toHaveLength(manifest.accept);
    expect(vectors.filter((vector) => vector.expected.outcome === 'reject')).toHaveLength(manifest.reject);
    expect(manifest.accept + manifest.reject).toBe(manifest.total);
    for (const entry of manifest.vectors) {
      const vector = readVector(join(directory, entry.file ?? `${entry.id}.json`), (value) => value as WebhookVector);
      expect(vector).toMatchObject({ id: entry.id, title: entry.title, route: entry.route, profile: manifest.profile });
      expect(vector.expected.outcome).toBe(entry.outcome);
      expect(vector.expected.reason).toBe(entry.reason);
      expect(['accept', 'reject']).toContain(entry.outcome);
      expect(['verify', 'parse']).toContain(vector.expected.phase ?? 'verify');
      if (entry.phase !== undefined) expect(vector.expected.phase ?? 'verify').toBe(entry.phase);
      if (entry.outcome === 'accept') expect(entry.reason).toBeNull();
      else expect(WEBHOOK_VERIFICATION_FAILURES).toContain(entry.reason);
      expect(Number.isSafeInteger(vector.verifyAt)).toBe(true);
    }
  });

  it.each(files.map((path) => ({ path, id: vectorId(path) })))(
    '$id reaches its declared outcome and phase',
    async ({ path }) => {
      const vector = readVector(path, (value) => value as WebhookVector);
      const request: VerifiableWebhook = {
        method: vector.request.method,
        targetUri: vector.request.targetUri,
        headers: vector.request.headers,
        body: decodeBody(vector.request.bodyBase64),
      };
      const verifier = new PartnerWebhookVerifier(
        { get: () => Promise.resolve(vector.signingKeys), refresh: () => Promise.resolve(vector.signingKeys) },
        vector.receiver,
        { now: () => new Date(vector.verifyAt * 1000) },
      );
      if (vector.expected.outcome === 'accept') {
        await expect(verifier.verify(request)).resolves.toBeUndefined();
        const envelope = await verifier.verifyAndParse(request);
        expect(envelope.id).toBe(vector.expected.envelope?.id);
        expect(envelope.rawType).toBe(vector.expected.envelope?.type);
        expect(envelope.applicationId).toBe(vector.expected.envelope?.applicationId);
        const headers = Object.fromEntries(
          Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value]),
        );
        const parsed = parseWebhookSignatureInput(headers['signature-input'] ?? '');
        if (!parsed) throw new Error(`Accepted vector ${vector.id} has malformed signature input.`);
        expect(
          new TextDecoder().decode(
            PartnerWebhookSignatureBase.build(
              request.method,
              vector.receiver.configuredUrl,
              headers['content-digest'] ?? '',
              headers['webhook-id'] ?? '',
              headers['anis-webhook-attempt'] ?? '',
              headers['anis-application-id'] ?? '',
              parsed.signatureParams,
            ),
          ),
        ).toBe(vector.signatureBaseForDebugging);
      } else {
        if (vector.expected.reason === null) throw new Error(`Rejected vector ${vector.id} has no declared reason.`);
        if (vector.expected.phase === 'parse') await expect(verifier.verify(request)).resolves.toBeUndefined();
        else
          await expect(verifier.verify(request)).rejects.toMatchObject({
            failure: vector.expected.reason,
          } satisfies Partial<UnverifiableWebhookError>);
        await expect(verifier.verifyAndParse(request)).rejects.toBeInstanceOf(UnverifiableWebhookError);
        await expect(verifier.verifyAndParse(request)).rejects.toMatchObject({
          failure: vector.expected.reason,
        } satisfies Partial<UnverifiableWebhookError>);
      }
    },
  );
});
