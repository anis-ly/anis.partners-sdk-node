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
