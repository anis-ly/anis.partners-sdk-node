import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebhookHandler, type WebhookInbox } from '../../samples/receiver/handler.js';
import type { SigningKeySet } from '../../src/verification/partner-jwk.js';

interface Vector {
  verifyAt: number;
  receiver: { configuredUrl: string; applicationId: string };
  signingKeys: SigningKeySet;
  request: { method: string; headers: Record<string, string>; bodyBase64: string };
}
const vector = JSON.parse(
  readFileSync(new URL('../vectors/webhook/WH-001-good.json', import.meta.url), 'utf8'),
) as Vector;
const queryVector = JSON.parse(
  readFileSync(new URL('../vectors/webhook/WH-038-query-target.json', import.meta.url), 'utf8'),
) as Vector;

function exchange(input: Vector = vector, path?: string) {
  const request = Object.assign(Readable.from([Buffer.from(input.request.bodyBase64, 'base64')]), {
    method: input.request.method,
    url: path ?? input.receiver.configuredUrl.replace(new URL(input.receiver.configuredUrl).origin, ''),
    headers: { ...input.request.headers, host: 'attacker.example', 'x-forwarded-host': 'attacker.example' },
  }) as unknown as IncomingMessage;
  const writeHead = vi.fn().mockReturnThis();
  const end = vi.fn().mockReturnThis();
  const response = { writeHead, end } as unknown as ServerResponse;
  return { request, response, writeHead, end };
}
function handler(inbox: WebhookInbox, input = vector) {
  return createWebhookHandler({ authority: 'https://partners.example', ...input.receiver, inbox });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(vector.verifyAt * 1000);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(vector.signingKeys)))),
  );
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('webhook receiver', () => {
  it.each([
    '/wrong-path',
    '/hooks/anis?wrong=query',
    '/hooks/../hooks/anis',
    '//host/hooks/anis',
    'https://pos.example.ly/hooks/anis',
  ])('refuses the actual wrong target %s before inbox admission', async (path) => {
    const processOnce = vi.fn(() => Promise.resolve());
    const call = exchange(vector, path);
    await handler({ processOnce })(call.request, call.response);
    expect(call.writeHead).toHaveBeenCalledWith(400);
    expect(processOnce).not.toHaveBeenCalled();
  });
  it('preserves the exact received query and ignores untrusted host headers', async () => {
    const processOnce = vi.fn(() => Promise.resolve());
    const receive = handler({ processOnce }, queryVector);
    const call = exchange(queryVector);
    await receive(call.request, call.response);
    expect(call.writeHead).toHaveBeenCalledWith(204);
    expect(processOnce).toHaveBeenCalledTimes(1);
    expect(processOnce).toHaveBeenCalledWith(expect.objectContaining({ type: 'meterCharge.succeeded' }));
    const wrong = exchange(queryVector, '/hooks/anis?wrong=query');
    await receive(wrong.request, wrong.response);
    expect(wrong.writeHead).toHaveBeenCalledWith(400);
    expect(processOnce).toHaveBeenCalledTimes(1);
  });
  it('awaits transactional inbox commit before acknowledging concurrent duplicates', async () => {
    const admitted = new Set<string>();
    const effects: string[] = [];
    let release!: () => void;
    const commit = new Promise<void>((resolve) => {
      release = resolve;
    });
    let tail = Promise.resolve();
    let admissions = 0;
    const inbox: WebhookInbox = {
      processOnce: (event) => {
        admissions += 1;
        const transaction = tail.then(async () => {
          if (admitted.has(event.id)) return;
          await commit;
          effects.push(event.id);
          admitted.add(event.id);
        });
        tail = transaction;
        return transaction;
      },
    };
    const receive = handler(inbox);
    const calls = [exchange(), exchange()];
    const pending = calls.map((call) => receive(call.request, call.response));
    // Both verifications and admission calls must reach the transaction before it is allowed to commit.
    await vi.waitFor(() => {
      expect(admissions).toBe(2);
    });
    expect(calls.every((call) => call.end.mock.calls.length === 0)).toBe(true);
    release();
    await Promise.all(pending);
    expect(effects).toEqual(['4bceba8e-55d1-59ec-b560-6c1e08f2ae3a']);
    expect(admitted.size).toBe(1);
    for (const call of calls) expect(call.writeHead).toHaveBeenCalledWith(204);
    const replay = exchange();
    await handler(inbox)(replay.request, replay.response);
    expect(effects).toHaveLength(1);
    expect(replay.writeHead).toHaveBeenCalledWith(204);
  });
  it('returns 500 on transaction failure and retries the same event', async () => {
    const processOnce = vi
      .fn<WebhookInbox['processOnce']>()
      .mockRejectedValueOnce(new Error('Transaction rolled back'))
      .mockResolvedValue(undefined);
    const receive = handler({ processOnce });
    const failed = exchange();
    await receive(failed.request, failed.response);
    expect(failed.writeHead).toHaveBeenCalledWith(500);
    const retry = exchange();
    await receive(retry.request, retry.response);
    expect(retry.writeHead).toHaveBeenCalledWith(204);
    expect(processOnce.mock.calls[0]?.[0].id).toBe(processOnce.mock.calls[1]?.[0].id);
  });
  it('never admits an event with a changed body', async () => {
    const processOnce = vi.fn(() => Promise.resolve());
    const call = exchange({
      ...vector,
      request: { ...vector.request, bodyBase64: Buffer.from('{}').toString('base64') },
    });
    await handler({ processOnce })(call.request, call.response);
    expect(call.writeHead).toHaveBeenCalledWith(400);
    expect(processOnce).not.toHaveBeenCalled();
  });
});
