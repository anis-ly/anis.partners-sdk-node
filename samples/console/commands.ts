import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  AnisEnrollmentClient,
  AnisPartnersClient,
  Money,
  PemP256Signer,
  type PartnerLogger,
  type RequestSigner,
} from '@anis-ly/partners';

/** Settings read from settings.json, then overridden by the documented environment variables. */
export interface SampleSettings {
  authority: string;
  keyFile: string;
  keyId: string;
  ordersFolder: string;
}

/** Dependencies the command runner accepts so help and dry-run behavior can be exercised without a live API. */
export interface SampleDependencies {
  stdout?: (text: string) => void;
  fetcher?: typeof globalThis.fetch;
  signer?: RequestSigner;
}

/** Loads sample settings from a JSON file and the partner's environment. */
export async function loadSampleSettings(
  path = resolve('samples/console/settings.json'),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<SampleSettings> {
  let fileSettings: Partial<SampleSettings> = {};
  try {
    fileSettings = JSON.parse(await readFile(path, 'utf8')) as Partial<SampleSettings>;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  const settings = {
    authority: environment.ANIS_PARTNERS_AUTHORITY ?? fileSettings.authority ?? '',
    keyFile: environment.SAMPLE_KEY_FILE ?? fileSettings.keyFile ?? 'partner-key.pem',
    keyId: environment.SAMPLE_KEY_ID ?? fileSettings.keyId ?? '',
    ordersFolder: environment.SAMPLE_ORDERS_FOLDER ?? fileSettings.ordersFolder ?? 'orders',
  };
  return {
    ...settings,
    keyFile: resolve(settings.keyFile),
    ordersFolder: resolve(settings.ordersFolder),
  };
}

/** Runs one sample command. Network commands accept `--dry-run`, which prints signed request metadata and sends nothing. */
export async function runSampleCommand(
  command: string,
  args: string[],
  settings: SampleSettings,
  dependencies: SampleDependencies = {},
): Promise<number | undefined> {
  const print = dependencies.stdout ?? console.log;
  if (command === 'help' || command.length === 0) {
    print(HELP);
    return;
  }
  const dryRun = args.includes('--dry-run');
  const preview = args.includes('--preview');
  const verbose = args.includes('--verbose');
  const showSecrets = args.includes('--show-secrets');
  const values = args.filter((arg) => !['--dry-run', '--preview', '--verbose', '--show-secrets'].includes(arg));
  const fetcher = wireFetch(dryRun, preview, print, dependencies.fetcher);
  if (command === 'enrol') {
    await enrol(settings, values, fetcher, print, !dryRun && !preview);
    return;
  }
  if (command === 'enrol-status') {
    await enrolStatus(settings, values, fetcher, print);
    return;
  }
  if (command === 'signing-keys') {
    printJson(await inspectSigningKeys(requireSetting(settings.authority, 'ANIS_PARTNERS_AUTHORITY'), fetcher), print);
    return;
  }
  const signer = dependencies.signer ?? (await readSigner(settings));
  const client = AnisPartnersClient.create({
    options: { authority: requireSetting(settings.authority, 'ANIS_PARTNERS_AUTHORITY') },
    signer,
    fetch: fetcher,
    logger: consoleLogger(print, verbose),
  });
  const walletId = values[0];
  const second = values[1];

  switch (command) {
    case 'profile': {
      printJson(await client.profile.get(), print);
      return;
    }
    case 'wallets': {
      printJson(await collect(client.wallets.list()), print);
      return;
    }
    case 'wallet': {
      printJson(await client.wallets.get(requireArg(walletId, 'wallet id')), print);
      return;
    }
    case 'categories': {
      printJson(await collect(client.catalogue.listCategories(requireArg(walletId, 'wallet id'))), print);
      return;
    }
    case 'subcategories': {
      printJson(
        await collect(
          client.catalogue.listSubcategories(requireArg(walletId, 'wallet id'), requireArg(second, 'category id')),
        ),
        print,
      );
      return;
    }
    case 'subcategory': {
      printJson(
        await client.catalogue.getSubcategory(requireArg(walletId, 'wallet id'), requireArg(second, 'subcategory id')),
        print,
      );
      return;
    }
    case 'cards': {
      printJson(
        await collect(
          client.catalogue.listCards(requireArg(walletId, 'wallet id'), requireArg(second, 'subcategory id')),
        ),
        print,
      );
      return;
    }
    case 'owned': {
      printJson(await collect(client.ownedCards.list(requireArg(walletId, 'wallet id'))), print);
      return;
    }
    case 'owned-card': {
      printJson(
        await client.ownedCards.get(requireArg(walletId, 'wallet id'), requireArg(second, 'sold card id')),
        print,
      );
      return;
    }
    case 'reveal': {
      printJson(
        await client.ownedCards.reveal(requireArg(walletId, 'wallet id'), requireArg(second, 'sold card id')),
        print,
        showSecrets,
      );
      return;
    }
    case 'reveal-invoice': {
      printJson(
        await client.ownedCards.revealInvoice(requireArg(walletId, 'wallet id'), requireArg(second, 'invoice id')),
        print,
        showSecrets,
      );
      return;
    }
    case 'diagnostic': {
      printJson(await client.diagnostics.checkSignature(), print);
      return;
    }
    case 'order':
      return placeOrder(client, settings, values, print, showSecrets);
    case 'resume':
      return resumeOrder(client, settings, values, print, showSecrets);
    case 'order-status': {
      printJson(await client.orders.get(requireArg(walletId, 'operation id')), print);
      return;
    }
    case 'tour': {
      await tour(client, settings, fetcher, print, showSecrets);
      return;
    }
    default:
      throw new TypeError(`Unknown command: ${command}. Run help for the command list.`);
  }
}

/** Generates and protects a new private key before submitting its public half for enrollment. */
export async function enrol(
  settings: SampleSettings,
  args: string[],
  fetcher: typeof globalThis.fetch = globalThis.fetch,
  print: (text: string) => void = console.log,
  protectKey = true,
): Promise<void> {
  const invitationId = requireArg(optionValue(args, '--invitation') ?? args[0], 'invitation id');
  const token = requireArg(optionValue(args, '--token') ?? args[1], 'enrollment token');
  const validityDays = Number(optionValue(args, '--days') ?? '365');
  if (!Number.isInteger(validityDays) || validityDays < 1)
    throw new RangeError('Enrollment validity must be a positive whole number of days.');
  const keyFile = resolve(optionValue(args, '--key-file') ?? settings.keyFile);
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicJwk = publicKey.export({ format: 'jwk' });
  if (publicJwk.x === undefined || publicJwk.y === undefined)
    throw new Error('Could not export P-256 public coordinates.');
  if (protectKey) {
    await mkdir(dirname(keyFile), { recursive: true });
    const keyFileHandle = await open(keyFile, 'wx', 0o600);
    try {
      await keyFileHandle.writeFile(privatePem, 'utf8');
    } finally {
      await keyFileHandle.close();
    }
    await chmod(keyFile, 0o600);
  }
  const signer = await PemP256Signer.fromPem(privatePem);
  const enrollment = AnisEnrollmentClient.create({
    authority: requireSetting(settings.authority, 'ANIS_PARTNERS_AUTHORITY'),
    invitationId,
    enrollmentToken: token,
    fetch: fetcher,
  });
  const submitted = await enrollment.submitKey({
    publicJwk: { kty: 'EC', crv: 'P-256', x: publicJwk.x, y: publicJwk.y },
    notBefore: new Date(),
    expiresAt: new Date(Date.now() + validityDays * 24 * 60 * 60 * 1000),
  });
  const proof = await enrollment.prove(submitted, signer);
  print(`Key id: ${submitted.keyId}`);
  print(`Safety code: ${submitted.safetyCode ?? '(unavailable)'}`);
  print(`Proof state: ${proof.proofState ?? 'unknown'}.`);
  if (proof.proofState !== 'accepted') {
    print('Ask Anis to restart enrollment if the challenge expired.');
    return;
  }
  print('Anis staff will call the technical contact to verify the safety code before the key becomes active.');
}

async function enrolStatus(
  settings: SampleSettings,
  args: string[],
  fetcher: typeof globalThis.fetch,
  print: (text: string) => void,
) {
  const enrollment = AnisEnrollmentClient.create({
    authority: requireSetting(settings.authority, 'ANIS_PARTNERS_AUTHORITY'),
    invitationId: requireArg(optionValue(args, '--invitation') ?? args[0], 'invitation id'),
    enrollmentToken: requireArg(optionValue(args, '--token') ?? args[1], 'enrollment token'),
    fetch: fetcher,
  });
  printJson(await enrollment.getStatus(), print);
}

async function placeOrder(
  client: AnisPartnersClient,
  settings: SampleSettings,
  args: string[],
  print: (text: string) => void,
  showSecrets: boolean,
): Promise<number | undefined> {
  const [walletId, subcategoryId, cardId, quantityText] = args;
  const quantity = Number(requireArg(quantityText, 'quantity'));
  if (!Number.isInteger(quantity) || quantity < 1) throw new RangeError('Quantity must be a positive whole number.');
  const operationId = canonicalOperationId(optionValue(args, '--operation') ?? randomUUID());
  const selectedCardId = requireArg(cardId, 'card id');
  const card = await findCard(
    client,
    requireArg(walletId, 'wallet id'),
    requireArg(subcategoryId, 'subcategory id'),
    selectedCardId,
  );
  if (card.unitPrice === undefined) throw new Error('This wallet has no sellable unit price for the selected card.');
  const priceOverride = optionValue(args, '--expected-unit-price');
  const unitPrice = priceOverride === undefined ? card.unitPrice : Money.of(priceOverride, card.unitPrice.currency);
  const reference = optionValue(args, '--reference');
  const order = {
    cardId: selectedCardId,
    quantity,
    expectedUnitPrice: unitPrice,
    expectedTotal: unitPrice.multiply(quantity),
    ...(reference === undefined ? {} : { externalReference: reference }),
    ...(args.includes('--use-allowed-debt') ? { useAllowedDebt: true } : {}),
  };
  const intent = { operationId, walletId, request: order, outcome: 'sent' };
  await mkdir(settings.ordersFolder, { recursive: true });
  const intentPath = join(settings.ordersFolder, `${operationId}.json`);
  await createJournal(intentPath, JSON.stringify(intent, null, 2));
  print(`Saved order intent ${operationId} before sending.`);
  let result: Awaited<ReturnType<AnisPartnersClient['orders']['create']>>;
  try {
    result = await client.orders.create(requireArg(walletId, 'wallet id'), operationId, order);
  } catch (error) {
    if (!isDryRunStop(error)) throw error;
    await unlink(intentPath);
    print(dryRunMessage(error));
    return;
  }
  if (result.kind === 'unknown' && isDryRunStop(result.cause)) {
    await unlink(intentPath);
    print(dryRunMessage(result.cause));
    return;
  }
  await updateJournal(intentPath, { ...intent, result });
  showOrderResult(result, print, showSecrets);
  return pendingOrderExitCode(result);
}

async function resumeOrder(
  client: AnisPartnersClient,
  settings: SampleSettings,
  args: string[],
  print: (text: string) => void,
  showSecrets: boolean,
): Promise<number | undefined> {
  const operationId = canonicalOperationId(requireArg(args[0], 'operation id'));
  const path = join(settings.ordersFolder, `${operationId}.json`);
  const intent = JSON.parse(await readFile(path, 'utf8')) as {
    operationId: string;
    walletId: string;
    request: {
      cardId: string;
      quantity: number;
      expectedUnitPrice: { amount: string; currency: string; asOf?: string };
      expectedTotal: { amount: string; currency: string; asOf?: string };
      externalReference?: string;
      useAllowedDebt?: boolean;
    };
    result?: { credentials?: readonly unknown[] };
  };
  const request = {
    ...intent.request,
    expectedUnitPrice: Money.of(
      intent.request.expectedUnitPrice.amount,
      intent.request.expectedUnitPrice.currency,
      intent.request.expectedUnitPrice.asOf === undefined ? undefined : new Date(intent.request.expectedUnitPrice.asOf),
    ),
    expectedTotal: Money.of(
      intent.request.expectedTotal.amount,
      intent.request.expectedTotal.currency,
      intent.request.expectedTotal.asOf === undefined ? undefined : new Date(intent.request.expectedTotal.asOf),
    ),
    ...(intent.request.externalReference === undefined ? {} : { externalReference: intent.request.externalReference }),
    ...(intent.request.useAllowedDebt === undefined ? {} : { useAllowedDebt: intent.request.useAllowedDebt }),
  };
  const journaledOperationId = canonicalOperationId(requireArg(intent.operationId, 'journal operation id'));
  let result: Awaited<ReturnType<AnisPartnersClient['orders']['resume']>>;
  try {
    result = await client.orders.resume(intent.walletId, journaledOperationId, request);
  } catch (error) {
    if (!isDryRunStop(error)) throw error;
    print(dryRunMessage(error));
    return;
  }
  if (result.kind === 'unknown' && isDryRunStop(result.cause)) {
    print(dryRunMessage(result.cause));
    return;
  }
  await updateJournal(path, { ...intent, result });
  showOrderResult(result, print, showSecrets);
  return pendingOrderExitCode(result);
}

function pendingOrderExitCode(result: Awaited<ReturnType<AnisPartnersClient['orders']['create']>>): number | undefined {
  return result.kind === 'unknown' || result.kind === 'processing' ? 4 : undefined;
}

async function createJournal(path: string, contents: string): Promise<void> {
  const journal = await open(path, 'wx', 0o600);
  try {
    await journal.writeFile(contents, 'utf8');
    await journal.sync();
  } catch (error) {
    await journal.close();
    await unlink(path).catch(() => undefined);
    throw error;
  }
  await journal.close();
}

const journalLocks = new Map<string, Promise<void>>();

async function updateJournal(path: string, candidate: Record<string, unknown>): Promise<void> {
  await withJournalLock(path, async () => {
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
      const current = await readJournal(path);
      const merged = mergeJournal(current, candidate);
      const temporary = await open(temporaryPath, 'wx', 0o600);
      try {
        await temporary.writeFile(JSON.stringify(merged, dateToWire, 2), 'utf8');
        await temporary.sync();
      } finally {
        await temporary.close();
      }
      const latest = await readJournal(path);
      const finalJournal = mergeJournal(latest, candidate);
      const replacement = await open(temporaryPath, 'w', 0o600);
      try {
        await replacement.writeFile(JSON.stringify(finalJournal, dateToWire, 2), 'utf8');
        await replacement.sync();
      } finally {
        await replacement.close();
      }
      await rename(temporaryPath, path);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  });
}

async function readJournal(path: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new TypeError('The order journal must contain a JSON object.');
  return parsed as Record<string, unknown>;
}

async function withJournalLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const key = resolve(path);
  const previous = journalLocks.get(key) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const tail = previous.then(() => gate);
  journalLocks.set(key, tail);
  await previous;
  try {
    return await action();
  } finally {
    release?.();
    if (journalLocks.get(key) === tail) journalLocks.delete(key);
  }
}

function mergeJournal(current: Record<string, unknown>, candidate: Record<string, unknown>): Record<string, unknown> {
  const currentResult = asJournalObject(current.result);
  const candidateResult = asJournalObject(candidate.result);
  if (candidateResult === undefined) return { ...current, ...candidate };
  const keepCompleted =
    currentResult?.kind === 'completed' && ['processing', 'unknown', 'replayed'].includes(String(candidateResult.kind));
  const selectedResult = keepCompleted ? currentResult : candidateResult;
  const existingCredentials = isUnknownArray(currentResult?.credentials) ? currentResult.credentials : [];
  const suppliedCredentials = isUnknownArray(candidateResult.credentials) ? candidateResult.credentials : [];
  const credentials = [...existingCredentials, ...suppliedCredentials];
  const result = credentials.length === 0 ? selectedResult : { ...selectedResult, credentials };
  return { ...current, ...candidate, result };
}

function asJournalObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function showOrderResult(
  result: Awaited<ReturnType<AnisPartnersClient['orders']['create']>>,
  print: (text: string) => void,
  showSecrets = false,
): void {
  print(`Order outcome: ${result.kind}`);
  if (result.kind === 'unknown' || result.kind === 'processing') print(`Resume operation: ${result.operationId}`);
  if (result.kind === 'completed')
    print(`Credentials released: ${String(result.credentials.length)}; store them in your secret store.`);
  if (result.kind === 'completed' && result.codesWithheld) print('Order completed; Anis withheld the credentials.');
  if (result.kind === 'processing' && result.order.status === 'recoveryExhausted')
    print('Recovery is exhausted; continue resuming the same operation id after several minutes.');
  if (result.kind === 'notPlaced') print(`Refusal code: ${result.refusal.code}; no order was placed.`);
  printJson(result, print, showSecrets);
}

async function tour(
  client: AnisPartnersClient,
  settings: SampleSettings,
  fetcher: typeof globalThis.fetch,
  print: (text: string) => void,
  showSecrets: boolean,
) {
  const profile = await client.profile.get();
  printJson(profile, print, showSecrets);
  const wallets = await collect(client.wallets.list());
  printJson(wallets, print, showSecrets);
  const wallet = wallets[0];
  if (wallet === undefined) {
    print('No wallet is available for this application.');
    return;
  }
  printJson(await client.wallets.get(wallet.id), print, showSecrets);
  const categories = await collect(client.catalogue.listCategories(wallet.id));
  printJson(categories, print, showSecrets);
  const category = categories[0];
  if (category !== undefined) {
    const subcategories = await collect(client.catalogue.listSubcategories(wallet.id, category.id));
    printJson(subcategories, print, showSecrets);
    const subcategory = subcategories[0];
    if (subcategory !== undefined) {
      printJson(await client.catalogue.getSubcategory(wallet.id, subcategory.id), print, showSecrets);
      printJson(await collect(client.catalogue.listCards(wallet.id, subcategory.id)), print, showSecrets);
    }
  }
  const owned = await collect(client.ownedCards.list(wallet.id));
  printJson(owned, print, showSecrets);
  const firstCard = owned[0];
  if (firstCard !== undefined) printJson(await client.ownedCards.get(wallet.id, firstCard.id), print, showSecrets);
  printJson(await client.diagnostics.checkSignature(), print, showSecrets);
  printJson(await inspectSigningKeys(settings.authority, fetcher), print, showSecrets);
}

async function findCard(client: AnisPartnersClient, walletId: string, subcategoryId: string, cardId: string) {
  for await (const card of client.catalogue.listCards(walletId, subcategoryId)) {
    if (card.id === cardId) return card;
  }
  throw new Error(`Card ${cardId} was not found in the selected subcategory.`);
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of items) result.push(item);
  return result;
}

function wireFetch(
  dryRun: boolean,
  preview: boolean,
  print: (text: string) => void,
  fetcher?: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    if (!dryRun && !preview) return (fetcher ?? globalThis.fetch)(input, init);
    const request = input instanceof Request ? input : new Request(input, init);
    const body = request.method === 'GET' || request.method === 'HEAD' ? '(no body)' : await request.clone().text();
    const headerNames: string[] = [];
    request.headers.forEach((_value, name) => headerNames.push(name));
    const hold = dryRun || !['GET', 'HEAD'].includes(request.method);
    print(
      `${hold ? 'DRY RUN — request not sent' : 'PREVIEW — read sent'}\n${request.method} ${request.url}\nHeader names: ${headerNames.join(', ')}\n${safeRequestBody(body) || '(empty body)'}`,
    );
    if (hold) throw new DryRunStop(preview);
    return (fetcher ?? globalThis.fetch)(input, init);
  };
}

class DryRunStop extends Error {
  readonly preview: boolean;

  constructor(preview = false) {
    super(preview ? 'The preview stopped before this request was sent.' : 'The request was shown and not sent.');
    this.preview = preview;
    this.name = 'DryRunStop';
  }
}

function isDryRunStop(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'DryRunStop') return true;
  return isDryRunStop(error.cause);
}

function dryRunMessage(error: unknown): string {
  return error instanceof DryRunStop && error.preview
    ? 'Preview complete: the request that changes data was not sent.'
    : 'Dry run complete: no request was sent.';
}

function safeRequestBody(body: string): string {
  if (body === '(no body)' || body.length === 0) return body;
  try {
    const parsed: unknown = JSON.parse(body);
    return JSON.stringify(
      parsed,
      (key, value: unknown) =>
        ['signature', 'd', 'privatekey', 'enrollmenttoken'].includes(key.toLowerCase()) ? '[redacted]' : value,
      2,
    );
  } catch {
    return '(non-JSON body omitted)';
  }
}

async function inspectSigningKeys(authority: string, fetcher: typeof globalThis.fetch) {
  const response = await fetcher(new URL('/.well-known/partner-signing-keys.json', authority));
  if (!response.ok) throw new Error(`Signing-key request failed with HTTP ${String(response.status)}.`);
  const document: unknown = await response.json();
  if (typeof document !== 'object' || document === null || !('keys' in document) || !Array.isArray(document.keys))
    return document;
  return {
    keys: document.keys.map((key: unknown) => {
      if (typeof key !== 'object' || key === null || !('d' in key)) return key;
      return Object.fromEntries(Object.entries(key).filter(([name]) => name !== 'd'));
    }),
  };
}

async function readSigner(settings: SampleSettings): Promise<RequestSigner> {
  if (settings.keyId.length === 0) throw new TypeError('Set SAMPLE_KEY_ID to the key id Anis issued.');
  return (await PemP256Signer.fromPemFile(requireSetting(settings.keyFile, 'SAMPLE_KEY_FILE'))).forKey(settings.keyId);
}

function consoleLogger(print: (text: string) => void, verbose: boolean): PartnerLogger {
  const emit = (level: string) => (message: string, fields: Record<string, unknown>) => {
    print(`${level} ${message} ${JSON.stringify(fields)}`);
  };
  return {
    debug: verbose ? emit('debug') : () => undefined,
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
  };
}

function printJson(value: unknown, print: (text: string) => void = console.log, showSecrets = false): void {
  print(JSON.stringify(value, (key, nested: unknown) => redactSecrets(key, nested, showSecrets), 2));
}

function redactSecrets(key: string, value: unknown, showSecrets: boolean): unknown {
  if (value instanceof Date) return value.toISOString();
  if (!showSecrets && (key === 'voucher' || key === 'serialNumber'))
    return typeof value === 'string' ? mask(value) : value;
  return value;
}

function dateToWire(_key: string, value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

function mask(value: string): string {
  if (value.length <= 4) return '****';
  return `${value.slice(0, 2)}${'*'.repeat(value.length - 4)}${value.slice(-2)}`;
}

function requireArg(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0) throw new TypeError(`A ${label} is required.`);
  return value;
}

function canonicalOperationId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    throw new TypeError('The operation id must be a UUID.');
  return value.toLowerCase();
}

function requireSetting(value: string, name: string): string {
  if (value.length === 0) throw new TypeError(`Set ${name} before running this command.`);
  return value;
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

const HELP = `Anis Partner SDK sample\n\nTry these: enrol, enrol-status, tour, profile, wallets, wallet, categories, subcategories, subcategory, cards, order, resume, order-status, owned, owned-card, reveal, reveal-invoice, diagnostic, signing-keys, help\nOptions: --dry-run (send nothing), --preview (send reads and hold mutations), --verbose, --show-secrets.`;

export const sampleHelp = HELP;
