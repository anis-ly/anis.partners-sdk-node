/** Parses the leading Retry-After integer within the signed 32-bit seconds range. */
export function retryAfterSeconds(value: string | null | undefined): number | undefined {
  const first = value?.split(',')[0]?.trim();
  if (first === undefined || !/^\d+$/.test(first)) return undefined;
  const seconds = Number(first);
  return Number.isSafeInteger(seconds) && seconds <= 2_147_483_647 ? seconds : undefined;
}
