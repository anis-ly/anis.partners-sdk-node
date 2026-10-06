import { describe, expect, it } from 'vitest';
import { inspect } from 'node:util';
import { parseRevealedCredential, parseRevealedCredentialCollection } from '../../src/models/cards.js';
import { contentDigestOf } from '../../src/signing/content-digest.js';
import { KeyedSigner } from '../../src/signing/keyed-signer.js';
import { PartnerRequestSigner } from '../../src/signing/partner-request-signer.js';
import { AnisApiError } from '../../src/errors/anis-api-error.js';

const credentialJson = {
  soldCardId: '6e5b2d70-4416-4a6e-900a-5528803a6a7d',
  serialNumber: 'serial-secret-12',
  voucher: 'voucher-secret-34',
};

describe('native inspection redaction', () => {
  it('redacts credential secrets nested in a completed order result', () => {
    const credential = parseRevealedCredential(credentialJson);
    const result = { kind: 'completed', credentials: [credential] };
    const output = inspect(result);

    expect(output).toContain('<redacted>');
    expect(output).not.toContain(credentialJson.serialNumber);
    expect(output).not.toContain(credentialJson.voucher);
  });

  it('redacts credential secrets nested in a reveal collection while retaining JSON data', () => {
    const collection = parseRevealedCredentialCollection({ items: [credentialJson] });
    const output = inspect(collection);

    expect(output).toContain('<redacted>');
    expect(output).not.toContain(credentialJson.serialNumber);
    expect(output).not.toContain(credentialJson.voucher);
    expect(JSON.stringify(collection)).toContain(credentialJson.voucher);
    expect(collection.items[0]?.toString()).toContain('<redacted>');
    expect(() => structuredClone(collection)).not.toThrow();
  });

  it('redacts API refusal details from native inspection', () => {
    const error = new AnisApiError({ status: 400, title: 'voucher-secret-34', detail: 'serial-secret-12' }, 400);
    const output = inspect(error);
    expect(output).not.toContain('voucher-secret-34');
    expect(output).not.toContain('serial-secret-12');
    expect(JSON.stringify(error)).not.toContain('voucher-secret-34');
  });

  it('redacts signature, nonce, and base when signed headers are inspected', async () => {
    const signed = await new PartnerRequestSigner(
      new KeyedSigner(
        { sign: () => Promise.resolve(new Uint8Array(64).fill(0x41)) },
        'b26bf827-8484-44aa-987a-b033e4cfa401',
      ),
    ).sign(
      'BodylessNonceMutation',
      {
        method: 'POST',
        authority: 'partners.example',
        path: '/v1/diagnostics/signature',
        canonicalQuery: '',
        anisDate: '2026-10-05T00:00:00Z',
        contentDigest: contentDigestOf(new Uint8Array()),
        nonce: 'nonce-secret',
      },
      1_791_172_800,
      1_791_172_860,
    );
    const output = inspect(signed);

    expect(output).toContain('<redacted>');
    expect(output).not.toContain(signed.signatureInput);
    expect(output).not.toContain(signed.signature);
    expect(output).not.toContain(signed.nonce);
    expect(output).not.toContain(new TextDecoder().decode(signed.signatureBase));
    expect(JSON.stringify(signed)).toContain(signed.signature);
  });
});
