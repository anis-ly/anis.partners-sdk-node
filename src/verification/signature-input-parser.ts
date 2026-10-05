/** Parsed fields needed to rebuild a response signature without trusting its advertised component list. */
export interface ParsedSignatureInput {
  /** Dictionary label checked against the one accepted label. */
  label: string;
  /** Quoted identifiers, including request binding, compared with the rebuilt profile. */
  identifiers: readonly string[];
  /** Unix creation time used for replay freshness checks. */
  created: number;
  /** Published key version used to resolve the verification key. */
  keyId: string;
  /** Optional algorithm; when present it must match the supported one. */
  algorithm?: string;
}

/** Strictly parses the single signature form emitted by Anis; accepting ambiguity would let a response choose its verifier. */
export function parseSignatureInput(value: string): ParsedSignatureInput | undefined {
  if (!value) return undefined;
  const equal = value.indexOf('=');
  if (equal <= 0 || value[equal + 1] !== '(') return undefined;
  const label = value.slice(0, equal);
  let index = equal + 2;
  const identifiers: string[] = [];
  while (index < value.length && value[index] !== ')') {
    if (value[index] === ' ') {
      while (value[index] === ' ') index++;
      continue;
    }
    if (value[index] !== '"') return undefined;
    const end = value.indexOf('"', index + 1);
    if (end < 0) return undefined;
    const name = value.slice(index + 1, end);
    index = end + 1;
    let requestBound = false;
    if (value[index] === ';') {
      if (!value.startsWith(';req', index)) return undefined;
      index += 4;
      requestBound = true;
    }
    identifiers.push(requestBound ? `${name};req` : name);
  }
  if (value[index] !== ')') return undefined;
  index++;
  let created: number | undefined;
  let keyId: string | undefined;
  let algorithm: string | undefined;
  while (index < value.length) {
    if (value[index] !== ';') return undefined;
    const start = index + 1;
    const eq = value.indexOf('=', start);
    if (eq < 0) return undefined;
    const name = value.slice(start, eq);
    index = eq + 1;
    if (value[index] === '"') {
      const end = value.indexOf('"', index + 1);
      if (end < 0) return undefined;
      const text = value.slice(index + 1, end);
      index = end + 1;
      if (name === 'keyid') keyId = text;
      else if (name === 'alg') algorithm = text;
    } else {
      let end = index;
      while (end < value.length && value[end] !== ';') end++;
      const text = value.slice(index, end);
      if (!/^\d+$/.test(text)) return undefined;
      const number = Number(text);
      if (!Number.isSafeInteger(number)) return undefined;
      if (name === 'created') created = number;
      index = end;
    }
  }
  if (created === undefined || keyId === undefined) return undefined;
  return { label, identifiers, created, keyId, ...(algorithm === undefined ? {} : { algorithm }) };
}
