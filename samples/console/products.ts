import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createJournal, updateJournal } from './journal.js';
import { Money, type AnisPartnersClient, type DirectRechargeAmountIn } from '@anis-ly/partners';

/** Commands for meter charges, direct recharges and webhook self-service. */
export const PRODUCT_COMMANDS: readonly string[] = [
  'meter-packages',
  'meter-charges',
  'meter-charge',
  'meter-resume',
  'meter-status',
  'recharge-products',
  'recharge-quote',
  'recharge',
  'recharge-resume',
  'recharge-status',
  'recharge-recipient',
  'webhook-endpoint',
  'webhook-set',
  'webhook-test',
  'webhook-events',
  'webhook-redeliver',
];

/** Output and dry-run hooks that the main command runner owns. */
export interface ProductCommandContext {
  client: AnisPartnersClient;
  ordersFolder: string;
  print: (text: string) => void;
  showSecrets: boolean;
  isDryRunStop: (error: unknown) => boolean;
  dryRunMessage: (error: unknown) => string;
}

interface MoneyJson {
  amount: string;
  currency: string;
}

interface Journal {
  kind: 'meterCharge' | 'directRecharge';
  operationId: string;
  walletId: string;
  request: Record<string, unknown>;
  result?: unknown;
}

const SECRET_KEYS = new Set(['code', 'challenge', 'value', 'valueName']);

/** Runs one product command and returns an exit status when the outcome is unresolved. */
export async function runProductCommand(
  command: string,
  values: string[],
  context: ProductCommandContext,
): Promise<number | undefined> {
  const { client, print } = context;
  const first = values[0];
  const second = values[1];
  switch (command) {
    case 'meter-packages':
      return show(context, await collect(client.meterCharges.getMeterPackages(required(first, 'wallet id'))));
    case 'meter-charges': {
      const status = option(values, '--status');
      const meterNumber = option(values, '--meter');
      return show(
        context,
        await collect(
          client.meterCharges.getMeterCharges(required(first, 'wallet id'), {
            ...(status === undefined ? {} : { status: status as 'processing' | 'succeeded' | 'failed' }),
            ...(meterNumber === undefined ? {} : { meterNumber }),
          }),
        ),
      );
    }
    case 'meter-charge':
      return placeMeterCharge(context, values);
    case 'meter-resume': {
      const journal = await readJournal(context, required(first, 'operation id'), 'meterCharge');
      const request = meterRequest(journal.request);
      return finish(context, journal, () => client.meterCharges.resume(journal.walletId, journal.operationId, request));
    }
    case 'meter-status':
      return show(context, await client.meterCharges.get(required(first, 'operation id')));
    case 'recharge-products': {
      const type = option(values, '--type');
      return show(
        context,
        await collect(
          client.directRechargeProducts.getDirectRechargeProducts(required(first, 'wallet id'), {
            ...(type === undefined ? {} : { type: type as 'external' | 'billing' }),
          }),
        ),
      );
    }
    case 'recharge-quote': {
      const amountIn = (option(values, '--in') ?? 'fx') as DirectRechargeAmountIn;
      return show(
        context,
        await client.directRechargeProducts.quote(
          required(first, 'wallet id'),
          required(second, 'product id'),
          required(values[2], 'amount'),
          amountIn,
        ),
      );
    }
    case 'recharge':
      return placeDirectRecharge(context, values);
    case 'recharge-resume': {
      const journal = await readJournal(context, required(first, 'operation id'), 'directRecharge');
      const request = rechargeRequest(journal.request);
      return finish(context, journal, () =>
        client.directRecharges.resume(journal.walletId, journal.operationId, request),
      );
    }
    case 'recharge-status':
      return show(context, await client.directRecharges.get(required(first, 'operation id')));
    case 'recharge-recipient': {
      // A signed change: shown once and never replayed automatically. Read the direct recharge before trying again.
      const recipient = recipientFields(values);
      const result = await client.directRecharges.updateRecipient(required(first, 'operation id'), { recipient });
      print(`Correction accepted; read recharge-status ${result.operationId} or wait for a webhook.`);
      return show(context, result);
    }
    case 'webhook-endpoint':
      return show(context, await client.webhookEndpoint.get());
    case 'webhook-set':
      return show(context, await client.webhookEndpoint.set({ url: required(first, 'endpoint URL') }));
    case 'webhook-test':
      return show(context, await client.webhookEndpoint.test());
    case 'webhook-events': {
      const status = option(values, '--status');
      const since = option(values, '--since');
      return show(
        context,
        await collect(
          client.webhookEvents.getWebhookEvents({
            ...(status === undefined ? {} : { status: status as 'pending' | 'delivered' | 'retrying' | 'failed' }),
            ...(since === undefined ? {} : { since: new Date(since) }),
          }),
        ),
      );
    }
    case 'webhook-redeliver':
      return show(context, await client.webhookEvents.redeliver(required(first, 'event id')));
    default:
      print(`Unknown product command: ${command}.`);
      return undefined;
  }
}

async function placeMeterCharge(context: ProductCommandContext, values: string[]): Promise<number | undefined> {
  const [walletId, packageId, meterNumber] = values;
  const wallet = required(walletId, 'wallet id');
  const selected = required(packageId, 'package id');
  let unitPrice: Money | undefined;
  for await (const item of context.client.meterCharges.getMeterPackages(wallet)) {
    if (item.id === selected) unitPrice = item.unitPrice;
  }
  if (unitPrice === undefined) throw new Error(`Package ${selected} is not offered to this wallet.`);
  const reference = option(values, '--reference');
  const request = {
    packageId: selected,
    meterNumber: required(meterNumber, 'meter number'),
    expectedTotal: unitPrice,
    ...(reference === undefined ? {} : { externalReference: reference }),
  };
  const journal: Journal = {
    kind: 'meterCharge',
    operationId: operationId(option(values, '--operation')),
    walletId: wallet,
    request: JSON.parse(JSON.stringify(request)) as Record<string, unknown>,
  };
  await saveIntent(context, journal);
  return finish(context, journal, () =>
    context.client.meterCharges.create(journal.walletId, journal.operationId, request),
  );
}

async function placeDirectRecharge(context: ProductCommandContext, values: string[]): Promise<number | undefined> {
  const [walletId, productId, payoutAmount] = values;
  const wallet = required(walletId, 'wallet id');
  const product = required(productId, 'product id');
  const payout = required(payoutAmount, 'payout amount');
  const quote = await context.client.directRechargeProducts.quote(wallet, product, payout, 'fx');
  const reference = option(values, '--reference');
  const note = option(values, '--note');
  const request = {
    productId: product,
    payoutAmount: payout,
    expectedTotal: quote.total,
    recipient: recipientFields(values),
    ...(note === undefined ? {} : { note }),
    ...(reference === undefined ? {} : { externalReference: reference }),
  };
  const journal: Journal = {
    kind: 'directRecharge',
    operationId: operationId(option(values, '--operation')),
    walletId: wallet,
    request: JSON.parse(JSON.stringify(request)) as Record<string, unknown>,
  };
  await saveIntent(context, journal);
  return finish(context, journal, () =>
    context.client.directRecharges.create(journal.walletId, journal.operationId, request),
  );
}

async function finish(
  context: ProductCommandContext,
  journal: Journal,
  send: () => Promise<{ kind: string; operationId: string; cause?: unknown }>,
): Promise<number | undefined> {
  const { print } = context;
  let result: { kind: string; operationId: string; cause?: unknown };
  try {
    result = await send();
  } catch (error) {
    if (!context.isDryRunStop(error)) throw error;
    await removeIntent(context, journal);
    print(context.dryRunMessage(error));
    return undefined;
  }
  if (result.kind === 'unknown' && context.isDryRunStop(result.cause)) {
    await removeIntent(context, journal);
    print(context.dryRunMessage(result.cause));
    return undefined;
  }
  await writeJournal(context, { ...journal, result });
  print(`Outcome: ${result.kind}`);
  if (result.kind === 'processing' || result.kind === 'unknown') print(`Resume operation: ${result.operationId}`);
  if (result.kind === 'notPlaced') print('The request was refused; nothing was charged.');
  show(context, result);
  return result.kind === 'processing' || result.kind === 'unknown' ? 4 : undefined;
}

function show(context: ProductCommandContext, value: unknown): number | undefined {
  context.print(
    JSON.stringify(
      value,
      (key, nested: unknown) => {
        if (nested instanceof Date) return nested.toISOString();
        if (!context.showSecrets && SECRET_KEYS.has(key) && typeof nested === 'string') return '[hidden]';
        return nested;
      },
      2,
    ),
  );
  return undefined;
}

function journalPath(context: ProductCommandContext, id: string): string {
  return join(context.ordersFolder, `${id}.json`);
}

// The intent is on disk and synced before anything is sent, so a restart can resume the same id and body.
async function saveIntent(context: ProductCommandContext, journal: Journal): Promise<void> {
  await mkdir(context.ordersFolder, { recursive: true });
  await createJournal(journalPath(context, journal.operationId), JSON.stringify(journal, null, 2));
  context.print(`Saved intent ${journal.operationId} before sending.`);
}

async function writeJournal(context: ProductCommandContext, journal: Journal): Promise<void> {
  await updateJournal(journalPath(context, journal.operationId), { ...journal });
}

async function removeIntent(context: ProductCommandContext, journal: Journal): Promise<void> {
  await unlink(journalPath(context, journal.operationId)).catch(() => undefined);
}

async function readJournal(context: ProductCommandContext, id: string, kind: Journal['kind']): Promise<Journal> {
  const parsed = JSON.parse(await readFile(journalPath(context, operationId(id)), 'utf8')) as Journal;
  if (parsed.kind !== kind) throw new TypeError(`Operation ${id} is not a ${kind} intent.`);
  return parsed;
}

function moneyOf(value: unknown): Money {
  const money = value as MoneyJson;
  return Money.of(money.amount, money.currency);
}

function meterRequest(request: Record<string, unknown>) {
  return {
    packageId: String(request.packageId),
    meterNumber: String(request.meterNumber),
    expectedTotal: moneyOf(request.expectedTotal),
    ...(typeof request.externalReference === 'string' ? { externalReference: request.externalReference } : {}),
  };
}

function rechargeRequest(request: Record<string, unknown>) {
  return {
    productId: String(request.productId),
    payoutAmount: String(request.payoutAmount),
    expectedTotal: moneyOf(request.expectedTotal),
    recipient: request.recipient as { key: string; value: string }[],
    ...(typeof request.note === 'string' ? { note: request.note } : {}),
    ...(typeof request.externalReference === 'string' ? { externalReference: request.externalReference } : {}),
  };
}

// Recipient fields are passed as repeated --recipient key=value options.
function recipientFields(values: string[]): { key: string; value: string }[] {
  const fields: { key: string; value: string }[] = [];
  values.forEach((value, index) => {
    if (value !== '--recipient') return;
    const pair = values[index + 1] ?? '';
    const separator = pair.indexOf('=');
    if (separator < 1) throw new TypeError('Pass recipient fields as --recipient key=value.');
    fields.push({ key: pair.slice(0, separator), value: pair.slice(separator + 1) });
  });
  if (fields.length === 0) throw new TypeError('At least one --recipient key=value is required.');
  return fields;
}

function operationId(value: string | undefined): string {
  const id = value ?? randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    throw new TypeError('The operation id must be a UUID.');
  return id.toLowerCase();
}

function option(values: string[], name: string): string | undefined {
  const index = values.indexOf(name);
  return index < 0 ? undefined : values[index + 1];
}

function required(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0) throw new TypeError(`A ${label} is required.`);
  return value;
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of items) result.push(item);
  return result;
}
