/** Parsed single-label webhook signature input; parameters retain their exact signed serialization. */
export interface ParsedWebhookSignatureInput {
  /** Dictionary label, checked independently on both signature headers. */
  label: string;
  /** Advertised identifiers, compared with the frozen webhook coverage. */
  identifiers: readonly string[];
  /** Unix signing instant. */
  created: number;
  /** Unix expiry, absent only so the lifetime check can report its specific failure. */
  expires?: number;
  /** Exact opaque published key id. */
  keyId: string;
  /** Mandatory webhook algorithm, checked by the verifier. */
  algorithm?: string;
  /** Mandatory profile discriminator, checked by the verifier. */
  tag?: string;
  /** Inner list and parameters as signed, without the dictionary label. */
  signatureParams: string;
}

/** Parses the unambiguous structured-field subset used by the webhook profile. */
export function parseWebhookSignatureInput(value: string): ParsedWebhookSignatureInput | undefined {
  const head = /^([a-z*][a-z0-9_.*-]*)=\(((?:"[^"\\\r\n]+"(?: "[^"\\\r\n]+")*)?)\)/.exec(value);
  if (!head) return undefined;
  const label = head[1];
  const covered = head[2];
  if (label === undefined || covered === undefined) return undefined;
  const identifiers = covered === '' ? [] : covered.slice(1, -1).split('" "');
  const parameters = new Map<string, string | number>();
  let rest = value.slice(head[0].length);
  while (rest !== '') {
    const parameter = /^;([a-z*][a-z0-9_.*-]*)=(?:"([\x20-\x21\x23-\x5b\x5d-\x7e]*)"|([0-9]+))/.exec(rest);
    if (!parameter) return undefined;
    const name = parameter[1];
    if (name === undefined || parameters.has(name)) return undefined;
    const text = parameter[2];
    const integer = parameter[3];
    if (text !== undefined) parameters.set(name, text);
    else if (integer !== undefined && Number.isSafeInteger(Number(integer))) parameters.set(name, Number(integer));
    else return undefined;
    rest = rest.slice(parameter[0].length);
  }
  const created = parameters.get('created');
  const expires = parameters.get('expires');
  const keyId = parameters.get('keyid');
  const algorithm = parameters.get('alg');
  const tag = parameters.get('tag');
  if (
    typeof created !== 'number' ||
    typeof keyId !== 'string' ||
    keyId === '' ||
    (expires !== undefined && typeof expires !== 'number') ||
    (algorithm !== undefined && typeof algorithm !== 'string') ||
    (tag !== undefined && typeof tag !== 'string')
  )
    return undefined;
  return {
    label,
    identifiers,
    created,
    keyId,
    ...(expires === undefined ? {} : { expires }),
    ...(algorithm === undefined ? {} : { algorithm }),
    ...(tag === undefined ? {} : { tag }),
    signatureParams: value.slice(label.length + 1),
  };
}
