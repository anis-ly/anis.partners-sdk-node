/**
 * The three request shapes accepted by the Partner API.
 *
 * @remarks The route selects a frozen shape; a second configurable map could drift from Anis's route rules and turn
 * a valid signature into an unexplained refusal.
 */
export type SignatureProfile = 'SafeRead' | 'BodylessNonceMutation' | 'OrderMutation';

/** Returns the frozen component order so the advertised list and signed bytes stay identical. */
export function componentsOf(profile: SignatureProfile): readonly string[] {
  switch (profile) {
    case 'SafeRead':
      return ['@method', '@authority', '@path', '@query', 'x-anis-date'];
    case 'BodylessNonceMutation':
      return ['@method', '@authority', '@path', '@query', 'content-digest', 'nonce', 'x-anis-date'];
    case 'OrderMutation':
      return ['@method', '@authority', '@path', '@query', 'content-digest', 'nonce', 'idempotency-key', 'x-anis-date'];
  }
}
