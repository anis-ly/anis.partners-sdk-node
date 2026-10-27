import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { AnisPartnersClient } from '@anis-ly/partners';
import { createJournal, updateJournal } from '../../samples/console/journal.js';
import { runProductCommand } from '../../samples/console/products.js';
import {
  accepted,
  signer,
  quote,
  rechargeId,
  rechargeIntent,
  walletId,
  productId,
} from '../operations/product-test-support.js';
import { signedFetchDouble } from '../support/signed-fetch.js';

describe('product sample recovery', () => {
  it('shows recipient acceptance and its read location without reading or replaying the operation', async () => {
    const location = `/v1/direct-recharges/${rechargeId}`;
    const fake = await signedFetchDouble(() => ({
      status: 202,
      body: JSON.stringify(accepted('directRecharge', rechargeId)),
      headers: { Location: location },
    }));
    const output: string[] = [];
    const result = await runProductCommand(
      'recharge-recipient',
      [rechargeId, '--recipient', 'recipient_number=01012345678'],
      {
        client: AnisPartnersClient.create({
          options: { authority: 'https://partners.example' },
          signer,
          fetch: fake.fetcher,
        }),
        ordersFolder: 'unused',
        print: (text) => {
          output.push(text);
        },
        showSecrets: false,
        isDryRunStop: () => false,
        dryRunMessage: () => '',
      },
    );
    expect(result).toBeUndefined();
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.init.method).toBe('PATCH');
    expect(output[0]).toBe(`Correction accepted; read recharge-status ${rechargeId} or wait for a webhook.`);
    expect(JSON.parse(output[1] ?? '')).toEqual({
      kind: 'processing',
      operationId: rechargeId,
      suggestedDelayMs: 5000,
      location,
      accepted: accepted('directRecharge', rechargeId),
    });
    expect(output.join('\n')).not.toContain('01012345678');
  });
  it('persists the direct recharge intent before sending and restores identical bytes after a restart', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'anis-recharge-'));
    const path = join(folder, `${rechargeId}.json`);
    const fake = await signedFetchDouble((url) =>
      url.pathname.endsWith('/quote')
        ? { body: JSON.stringify(quote) }
        : { status: 202, body: JSON.stringify(accepted('directRecharge', rechargeId)) },
    );
    let savedBeforeSend = 0;
    const fetcher: typeof globalThis.fetch = async (resource, init) => {
      const url = new URL(typeof resource === 'string' || resource instanceof URL ? resource : resource.url);
      if (url.pathname.endsWith('/direct-recharges')) {
        const saved = JSON.parse(await readFile(path, 'utf8')) as {
          operationId: string;
          walletId: string;
          request: unknown;
        };
        expect(saved).toMatchObject({
          operationId: rechargeId,
          walletId,
          request: {
            productId,
            payoutAmount: '1500.000',
            expectedTotal: { amount: '237.500', currency: 'LYD' },
            recipient: rechargeIntent.recipient,
          },
        });
        savedBeforeSend += 1;
      }
      return fake.fetcher(resource, init);
    };
    const context = () => ({
      client: AnisPartnersClient.create({ options: { authority: 'https://partners.example' }, signer, fetch: fetcher }),
      ordersFolder: folder,
      print: () => undefined,
      showSecrets: false,
      isDryRunStop: () => false,
      dryRunMessage: () => '',
    });
    const args = [
      walletId,
      productId,
      '1500.000',
      '--operation',
      rechargeId,
      '--recipient',
      'recipient_number=01012345678',
    ];
    try {
      expect(await runProductCommand('recharge', args, context())).toBe(4);
      expect(await runProductCommand('recharge-resume', [rechargeId], context())).toBe(4);
      const sends = fake.requests.filter((request) => request.url.pathname.endsWith('/direct-recharges'));
      expect(sends).toHaveLength(2);
      expect(sends[0]?.body).toEqual(sends[1]?.body);
      expect(sends.map((request) => new Headers(request.init.headers).get('Idempotency-Key'))).toEqual([
        rechargeId,
        rechargeId,
      ]);
      expect(savedBeforeSend).toBe(2);
      await expect(runProductCommand('recharge', args, context())).rejects.toMatchObject({ code: 'EEXIST' });
      expect(fake.requests.filter((request) => request.url.pathname.endsWith('/direct-recharges'))).toHaveLength(2);
      expect(await readdir(folder)).toEqual([`${rechargeId}.json`]);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
  it.each(['final', 'notPlaced'])(
    'preserves %s against concurrent and late unresolved journal updates',
    async (kind) => {
      const folder = await mkdtemp(join(tmpdir(), 'anis-product-journal-'));
      const path = join(folder, 'operation.json');
      try {
        await createJournal(path, JSON.stringify({ operationId: rechargeId, request: { exact: true } }));
        await Promise.all([
          updateJournal(path, { result: { kind, operationId: rechargeId, outcome: 'authoritative' } }),
          updateJournal(path, { result: { kind: 'processing', operationId: rechargeId } }),
        ]);
        await updateJournal(path, { result: { kind: 'unknown', operationId: rechargeId } });
        const stored: unknown = JSON.parse(await readFile(path, 'utf8'));
        expect(stored).toEqual({
          operationId: rechargeId,
          request: { exact: true },
          result: { kind, operationId: rechargeId, outcome: 'authoritative' },
        });
        expect(await readdir(folder)).toEqual(['operation.json']);
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    },
  );
});
