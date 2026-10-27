import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpSigningKeySource, PartnerWebhookVerifier, UnverifiableWebhookError } from '@anis-ly/partners';
import type { VerifiableWebhook, WebhookEnvelope } from '@anis-ly/partners';

/** Reads the raw request bytes. The signature covers them, so nothing may parse them first. */
async function readBody(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

/** Header values as received; a repeated header is joined, which the verifier then refuses as ambiguous. */
function headersOf(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
}

/** Durable inbox implemented by the receiver's application database. */
export interface WebhookInbox {
  /**
   * In ONE transaction, insert event.id under a unique constraint, apply business changes (or enqueue a durable
   * job/outbox record), and commit. A committed duplicate is a no-op. Concurrent inserts must wait for the first
   * transaction; rollback leaves the event retryable. Resolve only after commit, reject on failure.
   */
  processOnce(event: WebhookEnvelope): Promise<void>;
}

/** Builds a handler with trusted external settings and a transactional durable inbox. */
export function createWebhookHandler(options: {
  authority: string;
  configuredUrl: string;
  applicationId: string;
  inbox: WebhookInbox;
}) {
  const verifier = new PartnerWebhookVerifier(new HttpSigningKeySource({ authority: options.authority }), {
    configuredUrl: options.configuredUrl,
    applicationId: options.applicationId,
  });

  const externalOrigin = new URL(options.configuredUrl).origin;
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      // Use the raw origin-form path/query: URL resolution would normalize dot segments and encoded spelling.
      // Host and forwarding headers are untrusted. A proxy must preserve the external raw path/query.
      if (!request.url?.startsWith('/') || request.url.startsWith('//') || request.url.includes('#')) {
        response.writeHead(400).end();
        return;
      }
      const delivery: VerifiableWebhook = {
        method: request.method ?? '',
        targetUri: externalOrigin + request.url,
        headers: headersOf(request),
        body: await readBody(request),
      };
      const event = await verifier.verifyAndParse(delivery);
      if (event.type === 'unknown' && event.rawType === 'webhook_endpoint.verification') {
        // Echo the challenge only after verification, and keep it out of the logs.
        const challenge = event.data.challenge;
        if (typeof challenge !== 'string') throw new TypeError('The verification event carries no challenge.');
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ challenge }));
        return;
      }
      await options.inbox.processOnce(event);
      response.writeHead(204).end();
    } catch (error) {
      if (error instanceof UnverifiableWebhookError) {
        console.warn('Refused delivery:', error.failure);
        response.writeHead(400).end();
        return;
      }
      response.writeHead(500).end();
    }
  };
}
