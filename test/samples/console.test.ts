import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RequestSigner } from '@anis-ly/partners';
import type { PartnerJwk } from '../../src/verification/partner-jwk.js';
import { keyThumbprint } from '../../src/enrollment/key-thumbprint.js';
import { enrol } from '../../samples/console/commands.js';
import { runSampleCommand, sampleHelp } from '../../samples/console/commands.js';
import { signedFetchDouble } from '../support/signed-fetch.js';

describe('console sample commands', () => {
  it('prints help without constructing a client or calling the API', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof globalThis.fetch>();
    await runSampleCommand('help', [], settings, { stdout: (text) => output.push(text), fetcher });
    expect(output.join('\n')).toBe(sampleHelp);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('prints a signed dry-run request and leaves the network stub untouched', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof globalThis.fetch>();
    await expect(
      runSampleCommand('profile', ['--dry-run'], settings, {
        stdout: (text) => output.push(text),
        fetcher,
        signer,
      }),
    ).rejects.toMatchObject({ name: 'DryRunStop' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('GET https://partners.example/v1/profile');
    expect(output.join('\n')).toContain('signature');
    expect(output.join('\n')).toContain('signature-input');
    expect(output.join('\n')).not.toMatch(/signature: [A-Za-z0-9_-]{12}/);
  });

  it('prints the proof state after the key id and safety code during enrollment', async () => {
    const output: string[] = [];
    const invitationId = 'a9cb2df1-5a48-449b-8c8a-1b20a5b7f433';
    const fake = await signedFetchDouble((url, init) => {
      if (url.pathname.endsWith('/keys')) {
        if (!(init.body instanceof Uint8Array)) throw new TypeError('Expected the submitted enrollment JSON body.');
        const request = JSON.parse(new TextDecoder().decode(init.body)) as { publicJwk: PartnerJwk };
        return {
          body: JSON.stringify({
            keyId: invitationId,
            thumbprint: keyThumbprint(request.publicJwk),
            challenge: 'sample-proof-challenge',
            challengeGeneration: 1,
          }),
        };
      }
      return { body: JSON.stringify({ keyId: invitationId, proofState: 'accepted' }) };
    });

    await enrol(
      settings,
      ['--invitation', invitationId, '--token', 'test-token'],
      fake.fetcher,
      (line) => output.push(line),
      false,
    );

    expect(output[0]).toBe(`Key id: ${invitationId}`);
    expect(output[1]).toMatch(/^Safety code: [A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/);
    expect(output[2]).toBe('Proof state: accepted.');
  });

  it('stores the exact intent before handing the order request to fetch', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'anis-sdk-sample-'));
    const operationId = '00000000-0000-4000-8000-000000000005';
    const walletId = '00000000-0000-4000-8000-000000000003';
    const subcategoryId = '00000000-0000-4000-8000-000000000006';
    const cardId = '00000000-0000-4000-8000-000000000004';
    const fake = await signedFetchDouble((url) =>
      url.pathname.endsWith(`/catalog/subcategories/${subcategoryId}/cards`)
        ? {
            body: JSON.stringify({
              items: [
                {
                  id: cardId,
                  subcategoryId,
                  unitPrice: { amount: '10.500', currency: 'LYD' },
                  hasSpecialOffer: false,
                  available: true,
                },
              ],
            }),
          }
        : { status: 201, body: JSON.stringify({ operationId, status: 'completed', soldCards: [] }) },
    );
    const fetcher: typeof globalThis.fetch = async (resource, init) => {
      const url = new URL(typeof resource === 'string' || resource instanceof URL ? resource : resource.url);
      if (url.pathname.endsWith('/orders')) {
        const intent = JSON.parse(await readFile(join(folder, `${operationId}.json`), 'utf8')) as {
          operationId: string;
          request: { quantity: number; expectedTotal: { amount: string } };
        };
        expect(intent).toMatchObject({
          operationId,
          request: { quantity: 1, expectedTotal: { amount: '10.500' } },
        });
      }
      return fake.fetcher(resource, init);
    };

    try {
      await runSampleCommand(
        'order',
        [walletId, subcategoryId, cardId, '1', '--operation', operationId],
        { ...settings, ordersFolder: folder },
        { fetcher, signer, stdout: () => undefined },
      );
      expect(fake.requests.some((request) => request.url.pathname.endsWith('/orders'))).toBe(true);
      expect(await readdir(folder)).toEqual([`${operationId}.json`]);
      expect((await stat(join(folder, `${operationId}.json`))).mode & 0o777).toBe(0o600);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('allows only one concurrent order to create a journal for an operation id', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'anis-sdk-sample-'));
    const operationId = '00000000-0000-4000-8000-000000000005';
    const walletId = '00000000-0000-4000-8000-000000000003';
    const subcategoryId = '00000000-0000-4000-8000-000000000006';
    const cardId = '00000000-0000-4000-8000-000000000004';
    const fake = await signedFetchDouble((url) =>
      url.pathname.endsWith(`/catalog/subcategories/${subcategoryId}/cards`)
        ? {
            body: JSON.stringify({
              items: [
                {
                  id: cardId,
                  subcategoryId,
                  unitPrice: { amount: '10.500', currency: 'LYD' },
                  hasSpecialOffer: false,
                  available: true,
                },
              ],
            }),
          }
        : {
            status: 201,
            body: JSON.stringify({
              operationId,
              status: 'completed',
              soldCards: [{ soldCardId: cardId, voucher: 'FIRST-CREDENTIAL' }],
            }),
          },
    );
    const command = () =>
      runSampleCommand(
        'order',
        [walletId, subcategoryId, cardId, '1', '--operation', operationId],
        { ...settings, ordersFolder: folder },
        { fetcher: fake.fetcher, signer, stdout: () => undefined },
      );

    try {
      const outcomes = await Promise.allSettled([command(), command()]);
      const journal = JSON.parse(await readFile(join(folder, `${operationId}.json`), 'utf8')) as {
        result?: { credentials?: readonly { voucher?: string }[] };
      };

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
      expect(fake.requests.filter((request) => request.url.pathname.endsWith('/orders'))).toHaveLength(1);
      expect(journal.result?.credentials?.[0]?.voucher).toBe('FIRST-CREDENTIAL');
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('preserves a completion when a concurrent resume returns processing later', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'anis-sdk-sample-'));
    const operationId = '00000000-0000-4000-8000-000000000005';
    const walletId = '00000000-0000-4000-8000-000000000003';
    const cardId = '00000000-0000-4000-8000-000000000004';
    const journalPath = join(folder, `${operationId}.json`);
    await writeFile(
      journalPath,
      JSON.stringify({
        operationId,
        walletId,
        request: {
          cardId,
          quantity: 1,
          expectedUnitPrice: { amount: '10.500', currency: 'LYD' },
          expectedTotal: { amount: '10.500', currency: 'LYD' },
        },
      }),
      { mode: 0o600 },
    );
    let answerCount = 0;
    const fake = await signedFetchDouble((url) => {
      if (!url.pathname.endsWith('/orders')) return { body: '{}' };
      answerCount += 1;
      if (answerCount === 1)
        return {
          status: 201,
          body: JSON.stringify({
            operationId,
            status: 'completed',
            soldCards: [{ soldCardId: cardId, voucher: 'COMPLETED-CREDENTIAL' }],
          }),
        };
      return {
        status: 202,
        headers: { 'Retry-After': '1', Location: `/v1/orders/${operationId}` },
        body: JSON.stringify({ operationId, status: 'processing' }),
      };
    });
    let releaseFirst: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    const firstGate = new Promise<void>((resolveGate) => {
      releaseFirst = resolveGate;
    });
    const firstStarted = new Promise<void>((resolveStarted) => {
      markFirstStarted = resolveStarted;
    });
    let orderCalls = 0;
    const fetcher: typeof globalThis.fetch = async (resource, init) => {
      const url = new URL(typeof resource === 'string' || resource instanceof URL ? resource : resource.url);
      if (url.pathname.endsWith('/orders')) {
        orderCalls += 1;
        if (orderCalls === 1) {
          markFirstStarted?.();
          await firstGate;
        }
      }
      return fake.fetcher(resource, init);
    };
    const resume = () =>
      runSampleCommand(
        'resume',
        [operationId],
        { ...settings, ordersFolder: folder },
        { fetcher, signer, stdout: () => undefined },
      );

    try {
      const delayed = resume();
      await firstStarted;
      await expect(resume()).resolves.toBeUndefined();
      releaseFirst?.();
      await expect(delayed).resolves.toBe(4);

      const stored = JSON.parse(await readFile(journalPath, 'utf8')) as {
        result?: { kind?: string; credentials?: readonly { voucher?: string }[] };
      };
      expect(stored.result?.kind).toBe('completed');
      expect(stored.result?.credentials?.[0]?.voucher).toBe('COMPLETED-CREDENTIAL');
    } finally {
      releaseFirst?.();
      await rm(folder, { recursive: true, force: true });
    }
  });

  it.each([
    ['a replay answer', { status: 'completed', replayed: true }],
    ['an unknown answer', { status: 'unknown', replayed: false }],
  ])('preserves journaled credentials and operation id after %s', async (_label, outcome) => {
    const folder = await mkdtemp(join(tmpdir(), 'anis-sdk-sample-'));
    const journalPath = join(folder, '00000000-0000-4000-8000-000000000002.json');
    const journalOperation = '00000000-0000-4000-8000-000000000001';
    const walletId = '00000000-0000-4000-8000-000000000003';
    const cardId = '00000000-0000-4000-8000-000000000004';
    const journal = {
      operationId: journalOperation,
      walletId,
      request: {
        cardId,
        quantity: 1,
        expectedUnitPrice: { amount: '10.500', currency: 'LYD' },
        expectedTotal: { amount: '10.500', currency: 'LYD' },
      },
      result: { kind: 'completed', credentials: [{ voucher: 'JOURNALED-VOUCHER' }] },
    };
    await writeFile(journalPath, JSON.stringify(journal), { mode: 0o600 });
    const fake = await signedFetchDouble((url, init) => {
      if (init.headers === undefined) throw new TypeError('The signed request headers are missing.');
      expect(new Headers(init.headers).get('Idempotency-Key')).toBe(journalOperation);
      if (outcome.status === 'unknown') throw new TypeError('network unavailable');
      if (url.pathname.endsWith('/orders')) {
        return {
          body: JSON.stringify({ operationId: journalOperation, status: 'completed', soldCards: [] }),
          headers: { 'Idempotency-Replayed': 'true' },
        };
      }
      return { body: '{}' };
    });
    try {
      await runSampleCommand(
        'resume',
        ['00000000-0000-4000-8000-000000000002'],
        { ...settings, ordersFolder: folder },
        { fetcher: fake.fetcher, signer, stdout: () => undefined },
      );
      const stored = JSON.parse(await readFile(journalPath, 'utf8')) as typeof journal;
      expect(stored.result.credentials[0]?.voucher).toBe('JOURNALED-VOUCHER');
      expect(fake.requests[0]?.init.headers).toBeDefined();
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('refuses a path-like operation id before sending a request or naming a journal file', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'anis-sdk-sample-'));
    const fetcher = vi.fn<typeof globalThis.fetch>();
    const walletId = '00000000-0000-4000-8000-000000000003';
    const subcategoryId = '00000000-0000-4000-8000-000000000006';
    const cardId = '00000000-0000-4000-8000-000000000004';

    try {
      await expect(
        runSampleCommand(
          'order',
          [walletId, subcategoryId, cardId, '1', '--operation', '../outside'],
          { ...settings, ordersFolder: folder },
          { fetcher, signer },
        ),
      ).rejects.toBeInstanceOf(TypeError);
      expect(fetcher).not.toHaveBeenCalled();
      expect(await readdir(folder)).toEqual([]);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('preserves stored credentials after a completed-withheld response', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'anis-sdk-sample-'));
    const operationId = '00000000-0000-4000-8000-000000000001';
    const journalPath = join(folder, `${operationId}.json`);
    const original = {
      operationId,
      walletId: '00000000-0000-4000-8000-000000000003',
      request: {
        cardId: '00000000-0000-4000-8000-000000000004',
        quantity: 1,
        expectedUnitPrice: { amount: '10.500', currency: 'LYD' },
        expectedTotal: { amount: '10.500', currency: 'LYD' },
      },
      result: { kind: 'completed', credentials: [{ voucher: 'ORIGINAL-VOUCHER' }] },
    };
    await writeFile(journalPath, JSON.stringify(original), { mode: 0o600 });
    const fake = await signedFetchDouble(() => ({
      status: 201,
      body: JSON.stringify({ operationId, status: 'completed', soldCards: [], codesWithheld: true }),
    }));

    try {
      await runSampleCommand(
        'resume',
        [operationId],
        { ...settings, ordersFolder: folder },
        { fetcher: fake.fetcher, signer, stdout: () => undefined },
      );

      const stored = JSON.parse(await readFile(journalPath, 'utf8')) as typeof original;
      expect(stored.result.credentials[0]?.voucher).toBe('ORIGINAL-VOUCHER');
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it.each(['unknown', 'processing'] as const)('returns exit status 4 for a %s order outcome', async (outcome) => {
    const folder = await mkdtemp(join(tmpdir(), 'anis-sdk-sample-'));
    const operationId = '00000000-0000-4000-8000-000000000005';
    const walletId = '00000000-0000-4000-8000-000000000003';
    const subcategoryId = '00000000-0000-4000-8000-000000000006';
    const cardId = '00000000-0000-4000-8000-000000000004';
    const fake = await signedFetchDouble((url) => {
      if (url.pathname.endsWith(`/catalog/subcategories/${subcategoryId}/cards`))
        return {
          body: JSON.stringify({
            items: [
              {
                id: cardId,
                subcategoryId,
                unitPrice: { amount: '10.500', currency: 'LYD' },
                hasSpecialOffer: false,
                available: true,
              },
            ],
          }),
        };
      if (outcome === 'unknown') throw new TypeError('network unavailable');
      return {
        status: 202,
        headers: { 'Retry-After': '1', Location: `/v1/orders/${operationId}` },
        body: JSON.stringify({ operationId, status: 'processing' }),
      };
    });

    try {
      await expect(
        runSampleCommand(
          'order',
          [walletId, subcategoryId, cardId, '1', '--operation', operationId],
          { ...settings, ordersFolder: folder },
          { fetcher: fake.fetcher, signer, stdout: () => undefined },
        ),
      ).resolves.toBe(4);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});

const settings = {
  authority: 'https://partners.example',
  keyFile: '/unused/key.pem',
  keyId: '00000000-0000-4000-8000-000000000001',
  ordersFolder: '/unused/orders',
};

const signer: RequestSigner = {
  keyId: settings.keyId,
  sign() {
    return Promise.resolve(new Uint8Array(64));
  },
};
