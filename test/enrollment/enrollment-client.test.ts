import { describe, expect, it } from 'vitest';
import { inspect } from 'node:util';
import { AnisEnrollmentClient } from '../../src/enrollment/enrollment-client.js';
import { keyThumbprint } from '../../src/enrollment/key-thumbprint.js';
import { arrayBufferOf } from '../../src/internal/bytes.js';
import { signedFetchDouble } from '../support/signed-fetch.js';

const invitationId = 'a9cb2df1-5a48-449b-8c8a-1b20a5b7f433';
const enrollmentToken = 'enrollment-secret-token';

describe('AnisEnrollmentClient', () => {
  it('sends the enrollment token without a request signature and verifies the answer', async () => {
    const fake = await signedFetchDouble(() => ({ body: `{"invitationId":"${invitationId}","state":"pendingProof"}` }));
    const client = AnisEnrollmentClient.create({
      authority: 'https://partners.example',
      invitationId,
      enrollmentToken,
      fetch: fake.fetcher,
    });

    const state = await client.get();

    expect(state.state).toBe('pendingProof');
    const headers = new Headers(fake.requests[0]?.init.headers);
    expect(headers.get('Authorization')).toBe(`Enrollment ${enrollmentToken}`);
    expect(headers.has('Signature')).toBe(false);
  });

  it('does not include the enrollment token in structured logs', async () => {
    const messages: string[] = [];
    const fake = await signedFetchDouble(() => ({ body: `{"invitationId":"${invitationId}","state":"pendingProof"}` }));
    const client = AnisEnrollmentClient.create({
      authority: 'https://partners.example',
      invitationId,
      enrollmentToken,
      fetch: fake.fetcher,
      logger: {
        debug: (message, fields) => messages.push(JSON.stringify({ message, fields })),
        info: (message, fields) => messages.push(JSON.stringify({ message, fields })),
        warn: (message, fields) => messages.push(JSON.stringify({ message, fields })),
        error: (message, fields) => messages.push(JSON.stringify({ message, fields })),
      },
    });

    await client.get();

    expect(messages.join('\n')).not.toContain(enrollmentToken);
    expect(messages.length).toBeGreaterThan(0);
  });

  it('submits a public key, derives its safety code, and proves the signed challenge', async () => {
    const pair = await globalThis.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    const exported = await globalThis.crypto.subtle.exportKey('jwk', pair.publicKey);
    if (exported.x === undefined || exported.y === undefined) throw new TypeError('P-256 key omitted coordinates.');
    const publicJwk = {
      kty: 'EC' as const,
      crv: 'P-256' as const,
      x: exported.x,
      y: exported.y,
      kid: invitationId,
    };
    const thumbprint = keyThumbprint(publicJwk);
    const challenge = 'challenge-to-sign';
    const fake = await signedFetchDouble((url) =>
      url.pathname.endsWith('/keys')
        ? {
            body: JSON.stringify({ keyId: invitationId, thumbprint, challenge, challengeGeneration: 2 }),
          }
        : { body: JSON.stringify({ keyId: invitationId, challengeGeneration: 2, state: 'pendingApproval' }) },
    );
    const client = AnisEnrollmentClient.create({
      authority: 'https://partners.example',
      invitationId,
      enrollmentToken,
      fetch: fake.fetcher,
    });
    const submitted = await client.submitKey({
      publicJwk,
      notBefore: new Date('2026-10-05T00:00:00Z'),
      expiresAt: new Date('2027-10-05T00:00:00Z'),
    });
    const status = await client.prove(submitted, {
      sign: async (data) =>
        new Uint8Array(
          await globalThis.crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, arrayBufferOf(data)),
        ),
    });

    expect(submitted.thumbprint).toBe(thumbprint);
    expect(submitted.safetyCode).toMatch(/^[A-Z0-9]{4}(?:-[A-Z0-9]{4})+$/);
    expect(status.state).toBe('pendingApproval');
    expect(fake.requests.map((request) => request.url.pathname)).toEqual([
      `/v1/enrollments/${invitationId}/keys`,
      `/v1/enrollments/${invitationId}/proof`,
    ]);
    const headers = new Headers(fake.requests[1]?.init.headers);
    expect(headers.get('Authorization')).toBe(`Enrollment ${enrollmentToken}`);
    expect(headers.has('Signature')).toBe(false);
    expect(new Headers(fake.requests[0]?.init.headers).get('Content-Type')).toBe('application/json');
    expect(headers.get('Content-Type')).toBe('application/json');
    const submittedKey = new TextDecoder().decode(fake.requests[0]?.body);
    expect(JSON.parse(submittedKey)).toEqual({
      publicJwk: { kty: 'EC', crv: 'P-256', x: publicJwk.x, y: publicJwk.y },
      notBefore: '2026-10-05T00:00:00.000Z',
      expiresAt: '2027-10-05T00:00:00.000Z',
    });
  });

  it('stops before proof when the verified answer names a different key', async () => {
    const pair = await globalThis.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const exported = await globalThis.crypto.subtle.exportKey('jwk', pair.publicKey);
    if (exported.x === undefined || exported.y === undefined) throw new TypeError('P-256 key omitted coordinates.');
    const publicJwk = { kty: 'EC' as const, crv: 'P-256' as const, x: exported.x, y: exported.y, kid: invitationId };
    const fake = await signedFetchDouble(() => ({
      body: `{"keyId":"${invitationId}","thumbprint":"wrong","challenge":"c","challengeGeneration":1}`,
    }));
    const client = AnisEnrollmentClient.create({
      authority: 'https://partners.example',
      invitationId,
      enrollmentToken,
      fetch: fake.fetcher,
    });

    await expect(
      client.submitKey({
        publicJwk,
        notBefore: new Date('2026-10-05T00:00:00Z'),
        expiresAt: new Date('2027-10-05T00:00:00Z'),
      }),
    ).rejects.toMatchObject({ name: 'EnrollmentKeyMismatchError' });
    expect(fake.requests).toHaveLength(1);
  });

  it('rejects a verified key answer without its thumbprint', async () => {
    const pair = await globalThis.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const exported = await globalThis.crypto.subtle.exportKey('jwk', pair.publicKey);
    if (exported.x === undefined || exported.y === undefined) throw new TypeError('P-256 key omitted coordinates.');
    const fake = await signedFetchDouble(() => ({ body: `{"keyId":"${invitationId}","challenge":"c"}` }));
    const client = AnisEnrollmentClient.create({
      authority: 'https://partners.example',
      invitationId,
      enrollmentToken,
      fetch: fake.fetcher,
    });

    await expect(
      client.submitKey({
        publicJwk: { kty: 'EC', crv: 'P-256', x: exported.x, y: exported.y, kid: invitationId },
        notBefore: new Date('2026-10-05T00:00:00Z'),
        expiresAt: new Date('2027-10-05T00:00:00Z'),
      }),
    ).rejects.toMatchObject({ name: 'EnrollmentKeyMismatchError' });
  });

  it('refuses a key that cannot be thumbprinted before sending it', async () => {
    let calls = 0;
    const client = AnisEnrollmentClient.create({
      authority: 'https://partners.example',
      invitationId,
      enrollmentToken,
      fetch: () => {
        calls += 1;
        return Promise.resolve(new Response('{}'));
      },
    });

    await expect(
      client.submitKey({
        publicJwk: { kty: 'EC', crv: 'P-256', x: '', y: '', kid: invitationId },
        notBefore: new Date('2026-10-05T00:00:00Z'),
        expiresAt: new Date('2027-10-05T00:00:00Z'),
      }),
    ).rejects.toThrow(TypeError);
    expect(calls).toBe(0);
  });

  it('refuses a private JWK member before sending key material', async () => {
    let calls = 0;
    const client = AnisEnrollmentClient.create({
      authority: 'https://partners.example',
      invitationId,
      enrollmentToken,
      fetch: () => {
        calls += 1;
        return Promise.resolve(new Response('{}'));
      },
    });
    const privateJwk = {
      kty: 'EC',
      crv: 'P-256',
      x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      y: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      d: 'do-not-send',
    };

    await expect(
      client.submitKey({
        publicJwk: privateJwk,
        notBefore: new Date('2026-10-05T00:00:00Z'),
        expiresAt: new Date('2027-10-05T00:00:00Z'),
      }),
    ).rejects.toThrow('public JWK only');
    expect(calls).toBe(0);
  });

  it('keeps the enrollment token out of native inspection', () => {
    const client = AnisEnrollmentClient.create({
      authority: 'https://partners.example',
      invitationId,
      enrollmentToken,
      fetch: () => Promise.resolve(new Response('{}')),
    });

    expect(inspect(client)).not.toContain(enrollmentToken);
  });

  it('refuses to prove a submission that has no challenge', async () => {
    const client = AnisEnrollmentClient.create({
      authority: 'https://partners.example',
      invitationId,
      enrollmentToken,
      fetch: () => Promise.resolve(new Response('{}')),
    });

    await expect(
      client.prove({ keyId: invitationId }, { sign: () => Promise.resolve(new Uint8Array(64)) }),
    ).rejects.toThrow('Enrollment key answer has no challengeGeneration.');
  });

  it('refuses a DER-sized proof signature before sending the proof', async () => {
    let calls = 0;
    const client = AnisEnrollmentClient.create({
      authority: 'https://partners.example',
      invitationId,
      enrollmentToken,
      fetch: () => {
        calls += 1;
        return Promise.resolve(new Response('{}'));
      },
    });

    await expect(
      client.prove(
        { keyId: invitationId, challenge: 'challenge', challengeGeneration: 1, thumbprint: 'thumbprint' },
        { sign: () => Promise.resolve(new Uint8Array(71)) },
      ),
    ).rejects.toThrow('64-byte P-256 P1363');
    expect(calls).toBe(0);
  });

  it('maps a refused proof step to the typed enrollment error', async () => {
    const fake = await signedFetchDouble(() => ({
      status: 409,
      body: '{"status":409,"code":"challenge_expired"}',
    }));
    const client = AnisEnrollmentClient.create({
      authority: 'https://partners.example',
      invitationId,
      enrollmentToken,
      fetch: fake.fetcher,
    });

    await expect(
      client.submitProof({ keyId: invitationId, challengeGeneration: 1, signature: 'A'.repeat(86) }),
    ).rejects.toMatchObject({ name: 'EnrollmentRefusedError', code: 'challenge_expired' });
  });

  it('reads status with an optional key end date', async () => {
    const fake = await signedFetchDouble(() => ({
      body: `{"keyId":"${invitationId}","state":"active","keyExpiresAt":"2027-10-05T00:00:00Z"}`,
    }));
    const client = AnisEnrollmentClient.create({
      authority: 'https://partners.example',
      invitationId,
      enrollmentToken,
      fetch: fake.fetcher,
    });

    const status = await client.getStatus();

    expect(status.keyExpiresAt).toEqual(new Date('2027-10-05T00:00:00Z'));
    expect(new Headers(fake.requests[0]?.init.headers).get('Authorization')).toBe(`Enrollment ${enrollmentToken}`);
  });

  it('keeps an absent key end date optional in status answers', async () => {
    const fake = await signedFetchDouble(() => ({ body: `{"keyId":"${invitationId}","state":"pendingApproval"}` }));
    const client = AnisEnrollmentClient.create({
      authority: 'https://partners.example',
      invitationId,
      enrollmentToken,
      fetch: fake.fetcher,
    });

    const status = await client.getStatus();

    expect(status.keyExpiresAt).toBeUndefined();
  });
});
