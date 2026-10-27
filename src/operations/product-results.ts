import type { AnisApiError } from '../errors/anis-api-error.js';
import type { MeterCharge, MeterChargeAccepted } from '../models/meter-charges.js';
import type { DirectRecharge, DirectRechargeAccepted } from '../models/direct-recharges.js';

/** Outcome of a caller-keyed meterCharge create or resume. */
export type MeterChargeResult =
  | MeterChargeProcessing
  | MeterChargeFinal
  | MeterChargeNotPlaced
  | MeterChargeOutcomeUnknown;
/** An accepted operation or a current nonterminal owner read. */
export type MeterChargeProcessing = {
  /** Recovery discriminator. */ kind: 'processing';
  /** Original caller-owned id. */ operationId: string;
  /** Delay before resuming the same saved intent. */ suggestedDelayMs: number;
  /** Verified response Location, when supplied. */ location?: string;
} & (
  | {
      /** Exact three-member processing acknowledgement. */ accepted: MeterChargeAccepted;
      /** No owner projection was supplied. */ meterCharge?: never;
    }
  | {
      /** Current nonterminal owner state. */ meterCharge: MeterCharge;
      /** Full reads are separate from acknowledgements. */ accepted?: never;
    }
);
/** An authoritative terminal owner state, including a refunded failure. */
export interface MeterChargeFinal {
  /** Recovery discriminator. */ kind: 'final';
  /** Original caller-owned id. */ operationId: string;
  /** Complete current owner read. */ meterCharge: MeterCharge;
}
/** Verified definitive refusal that closed this application's attempt. */
export interface MeterChargeNotPlaced {
  /** Recovery discriminator. */ kind: 'notPlaced';
  /** Original caller-owned id. */ operationId: string;
  /** Typed signed refusal. */ refusal: AnisApiError;
}
/**
 * The attempt remains unresolved; never replace its id. This includes an `idempotency_conflict` refusal: the id may
 * already have been accepted and charged, so read the operation by its id (`get`) before any new attempt.
 */
export interface MeterChargeOutcomeUnknown {
  /** Recovery discriminator. */ kind: 'unknown';
  /** Original caller-owned id. */ operationId: string;
  /** Suggested recovery delay. */ suggestedDelayMs: number;
  /** Failure that prevented a trustworthy outcome. */ cause: unknown;
}

/** Outcome of a caller-keyed directRecharge create or resume. */
export type DirectRechargeResult =
  | DirectRechargeProcessing
  | DirectRechargeFinal
  | DirectRechargeNotPlaced
  | DirectRechargeOutcomeUnknown;
/** An accepted operation or a current nonterminal owner read. */
export type DirectRechargeProcessing = {
  /** Recovery discriminator. */ kind: 'processing';
  /** Original caller-owned id. */ operationId: string;
  /** Delay before resuming the same saved intent. */ suggestedDelayMs: number;
  /** Verified response Location, when supplied. */ location?: string;
} & (
  | {
      /** Exact three-member processing acknowledgement. */ accepted: DirectRechargeAccepted;
      /** No owner projection was supplied. */ directRecharge?: never;
    }
  | {
      /** Current nonterminal owner state. */ directRecharge: DirectRecharge;
      /** Full reads are separate from acknowledgements. */ accepted?: never;
    }
);
/** An authoritative terminal owner state, including a refunded failure. */
export interface DirectRechargeFinal {
  /** Recovery discriminator. */ kind: 'final';
  /** Original caller-owned id. */ operationId: string;
  /** Complete current owner read. */ directRecharge: DirectRecharge;
}
/** Verified definitive refusal that closed this application's attempt. */
export interface DirectRechargeNotPlaced {
  /** Recovery discriminator. */ kind: 'notPlaced';
  /** Original caller-owned id. */ operationId: string;
  /** Typed signed refusal. */ refusal: AnisApiError;
}
/**
 * The attempt remains unresolved; never replace its id. This includes an `idempotency_conflict` refusal: the id may
 * already have been accepted and charged, so read the operation by its id (`get`) before any new attempt.
 */
export interface DirectRechargeOutcomeUnknown {
  /** Recovery discriminator. */ kind: 'unknown';
  /** Original caller-owned id. */ operationId: string;
  /** Suggested recovery delay. */ suggestedDelayMs: number;
  /** Failure that prevented a trustworthy outcome. */ cause: unknown;
}
