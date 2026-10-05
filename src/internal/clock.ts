/** Supplies the instant used for response freshness checks. */
export interface Clock {
  /** Returns the current instant; injection lets tests pin the same whole-second window as Anis. */
  now(): Date;
}

/** Uses the host clock in production while keeping the clock replaceable for deterministic freshness tests. */
export const systemClock: Clock = { now: () => new Date() };
