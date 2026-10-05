import type { SignatureProfile } from '../signing/signature-profile.js';

/** One route from the SDK's closed Partner API surface. */
export interface PartnerRoute {
  /** HTTP method the SDK sends. */
  method: string;
  /** Published path template, with identifiers left as placeholders. */
  template: string;
  /** Required signing profile, or absent for enrollment-token and public key-document routes. */
  profile?: SignatureProfile;
}

/**
 * Closed route table held against the published OpenAPI contract by drift tests.
 *
 * @remarks A local route can drift in either direction: an invented route may be refused, while an omitted published
 * route leaves a partner unable to reach part of the API. The drift test checks both.
 */
export const PARTNER_ROUTES = [
  { method: 'GET', template: '/v1/profile', profile: 'SafeRead' },
  { method: 'GET', template: '/v1/wallets', profile: 'SafeRead' },
  { method: 'GET', template: '/v1/wallets/{walletId}', profile: 'SafeRead' },
  { method: 'GET', template: '/v1/wallets/{walletId}/catalog/categories', profile: 'SafeRead' },
  {
    method: 'GET',
    template: '/v1/wallets/{walletId}/catalog/categories/{categoryId}/subcategories',
    profile: 'SafeRead',
  },
  { method: 'GET', template: '/v1/wallets/{walletId}/catalog/subcategories/{subcategoryId}', profile: 'SafeRead' },
  {
    method: 'GET',
    template: '/v1/wallets/{walletId}/catalog/subcategories/{subcategoryId}/cards',
    profile: 'SafeRead',
  },
  { method: 'POST', template: '/v1/wallets/{walletId}/orders', profile: 'OrderMutation' },
  { method: 'GET', template: '/v1/orders/{operationId}', profile: 'SafeRead' },
  { method: 'GET', template: '/v1/wallets/{walletId}/cards', profile: 'SafeRead' },
  { method: 'GET', template: '/v1/wallets/{walletId}/cards/{soldCardId}', profile: 'SafeRead' },
  { method: 'POST', template: '/v1/wallets/{walletId}/cards/{soldCardId}/reveal', profile: 'BodylessNonceMutation' },
  {
    method: 'POST',
    template: '/v1/wallets/{walletId}/invoices/{invoiceId}/cards/reveal',
    profile: 'BodylessNonceMutation',
  },
  { method: 'POST', template: '/v1/diagnostics/signature', profile: 'BodylessNonceMutation' },
  { method: 'GET', template: '/v1/enrollments/{invitationId}' },
  { method: 'POST', template: '/v1/enrollments/{invitationId}/keys' },
  { method: 'POST', template: '/v1/enrollments/{invitationId}/proof' },
  { method: 'GET', template: '/v1/enrollments/{invitationId}/status' },
  { method: 'GET', template: '/.well-known/partner-signing-keys.json' },
] as const satisfies readonly PartnerRoute[];
