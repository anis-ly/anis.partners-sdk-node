import type { SignatureProfile } from '../signing/signature-profile.js';

/** One route from the SDK's closed Partner API surface. */
export interface PartnerRoute {
  /** HTTP method the SDK sends. */
  method: string;
  /** Published path template, with identifiers left as placeholders. */
  template: string;
  /** Required signing profile, or absent for enrollment-token and public key-document routes. */
  profile?: SignatureProfile;
  /**
   * Whether Anis signs every answer on this route, success and refusal alike.
   *
   * @remarks Stated on every route rather than detected from the answer: a signed route whose answer arrives without a
   * signature is refused as `signature_missing`, and only a route declared `false` here is read unverified. Answers
   * that move money, deliver card codes or establish a key are signed; information reads and the public key document
   * are not.
   */
  signedResponse: boolean;
  /** Stable gateway route id, when published for this resource. */
  routeId?: string;
  /** Required scope; null denotes an admitted scope-free route. */
  scope?: string | null;
  /** Whether Runtime binds the request to the route wallet. */
  walletBound?: boolean;
}

/**
 * Closed route table held against the published OpenAPI contract by drift tests.
 *
 * @remarks A local route can drift in either direction: an invented route may be refused, while an omitted published
 * route leaves a partner unable to reach part of the API. The drift test checks both, along with each route's signing
 * profile and whether its answers are signed.
 */
export const PARTNER_ROUTES = [
  { method: 'POST', template: '/v1/application/suspend', profile: 'BodylessNonceMutation', signedResponse: true },
  { method: 'POST', template: '/v1/keys/{keyId}/revoke', profile: 'BodylessNonceMutation', signedResponse: true },
  {
    method: 'GET',
    template: '/v1/wallets/{walletId}/catalog/cards/{cardId}',
    profile: 'SafeRead',
    signedResponse: false,
  },
  { method: 'GET', template: '/v1/profile', profile: 'SafeRead', signedResponse: false },
  { method: 'GET', template: '/v1/wallets', profile: 'SafeRead', signedResponse: false },
  { method: 'GET', template: '/v1/wallets/{walletId}', profile: 'SafeRead', signedResponse: false },
  { method: 'GET', template: '/v1/wallets/{walletId}/catalog/categories', profile: 'SafeRead', signedResponse: false },
  {
    method: 'GET',
    template: '/v1/wallets/{walletId}/catalog/categories/{categoryId}/subcategories',
    profile: 'SafeRead',
    signedResponse: false,
  },
  {
    method: 'GET',
    template: '/v1/wallets/{walletId}/catalog/subcategories/{subcategoryId}',
    profile: 'SafeRead',
    signedResponse: false,
  },
  {
    method: 'GET',
    template: '/v1/wallets/{walletId}/catalog/subcategories/{subcategoryId}/cards',
    profile: 'SafeRead',
    signedResponse: false,
  },
  { method: 'POST', template: '/v1/wallets/{walletId}/orders', profile: 'OrderMutation', signedResponse: true },
  { method: 'GET', template: '/v1/orders/{operationId}', profile: 'SafeRead', signedResponse: true },
  { method: 'GET', template: '/v1/wallets/{walletId}/owned-cards', profile: 'SafeRead', signedResponse: false },
  {
    method: 'GET',
    template: '/v1/wallets/{walletId}/owned-cards/{soldCardId}',
    profile: 'SafeRead',
    signedResponse: false,
  },
  {
    method: 'POST',
    template: '/v1/wallets/{walletId}/owned-cards/{soldCardId}/reveal',
    profile: 'BodylessNonceMutation',
    signedResponse: true,
  },
  {
    method: 'POST',
    template: '/v1/wallets/{walletId}/invoices/{invoiceId}/owned-cards/reveal',
    profile: 'BodylessNonceMutation',
    signedResponse: true,
  },
  { method: 'POST', template: '/v1/diagnostics/signature', profile: 'BodylessNonceMutation', signedResponse: true },
  { method: 'GET', template: '/v1/enrollments/{invitationId}', signedResponse: true },
  { method: 'POST', template: '/v1/enrollments/{invitationId}/keys', signedResponse: true },
  { method: 'POST', template: '/v1/enrollments/{invitationId}/proof', signedResponse: true },
  { method: 'GET', template: '/v1/enrollments/{invitationId}/status', signedResponse: true },
  { method: 'GET', template: '/.well-known/partner-signing-keys.json', signedResponse: false },
  {
    method: 'GET',
    template: '/v1/wallets/{walletId}/meter-packages',
    profile: 'SafeRead',
    signedResponse: false,
    routeId: 'partner.meter-packages.getMeterPackages',
    scope: 'meter_charges:read',
    walletBound: true,
  },
  {
    method: 'GET',
    template: '/v1/wallets/{walletId}/meter-charges',
    profile: 'SafeRead',
    signedResponse: false,
    routeId: 'partner.meter-charges.getMeterCharges',
    scope: 'meter_charges:read',
    walletBound: true,
  },
  {
    method: 'POST',
    template: '/v1/wallets/{walletId}/meter-charges',
    profile: 'OrderMutation',
    signedResponse: true,
    routeId: 'partner.meter-charges.create',
    scope: 'meter_charges:create',
    walletBound: true,
  },
  {
    method: 'GET',
    template: '/v1/meter-charges/{operationId}',
    profile: 'SafeRead',
    signedResponse: true,
    routeId: 'partner.meter-charges.read',
    scope: 'meter_charges:read',
    walletBound: false,
  },
  {
    method: 'GET',
    template: '/v1/wallets/{walletId}/direct-recharge-products',
    profile: 'SafeRead',
    signedResponse: false,
    routeId: 'partner.direct-recharge-products.getDirectRechargeProducts',
    scope: 'direct_recharges:read',
    walletBound: true,
  },
  {
    method: 'GET',
    template: '/v1/wallets/{walletId}/direct-recharge-products/{productId}',
    profile: 'SafeRead',
    signedResponse: false,
    routeId: 'partner.direct-recharge-products.read',
    scope: 'direct_recharges:read',
    walletBound: true,
  },
  {
    method: 'GET',
    template: '/v1/wallets/{walletId}/direct-recharge-products/{productId}/locations',
    profile: 'SafeRead',
    signedResponse: false,
    routeId: 'partner.direct-recharge-products.locations.getDirectRechargeProductLocations',
    scope: 'direct_recharges:read',
    walletBound: true,
  },
  {
    method: 'GET',
    template: '/v1/wallets/{walletId}/direct-recharge-products/{productId}/quote',
    profile: 'SafeRead',
    signedResponse: false,
    routeId: 'partner.direct-recharge-products.quote',
    scope: 'direct_recharges:read',
    walletBound: true,
  },
  {
    method: 'GET',
    template: '/v1/wallets/{walletId}/direct-recharges',
    profile: 'SafeRead',
    signedResponse: false,
    routeId: 'partner.direct-recharges.getDirectRecharges',
    scope: 'direct_recharges:read',
    walletBound: true,
  },
  {
    method: 'POST',
    template: '/v1/wallets/{walletId}/direct-recharges',
    profile: 'OrderMutation',
    signedResponse: true,
    routeId: 'partner.direct-recharges.create',
    scope: 'direct_recharges:create',
    walletBound: true,
  },
  {
    method: 'GET',
    template: '/v1/direct-recharges/{operationId}',
    profile: 'SafeRead',
    signedResponse: true,
    routeId: 'partner.direct-recharges.read',
    scope: 'direct_recharges:read',
    walletBound: false,
  },
  {
    method: 'PATCH',
    template: '/v1/direct-recharges/{operationId}/recipient',
    profile: 'BodylessNonceMutation',
    signedResponse: true,
    routeId: 'partner.direct-recharges.recipient.update',
    scope: 'direct_recharges:create',
    walletBound: false,
  },
  {
    method: 'GET',
    template: '/v1/webhook-endpoint',
    profile: 'SafeRead',
    signedResponse: false,
    routeId: 'partner.webhook-endpoint.read',
    scope: null,
    walletBound: false,
  },
  {
    method: 'PUT',
    template: '/v1/webhook-endpoint',
    profile: 'BodylessNonceMutation',
    signedResponse: true,
    routeId: 'partner.webhook-endpoint.update',
    scope: null,
    walletBound: false,
  },
  {
    method: 'POST',
    template: '/v1/webhook-endpoint/test',
    profile: 'BodylessNonceMutation',
    signedResponse: true,
    routeId: 'partner.webhook-endpoint.test',
    scope: null,
    walletBound: false,
  },
  {
    method: 'GET',
    template: '/v1/webhook-events',
    profile: 'SafeRead',
    signedResponse: false,
    routeId: 'partner.webhook-events.getWebhookEvents',
    scope: null,
    walletBound: false,
  },
  {
    method: 'POST',
    template: '/v1/webhook-events/{eventId}/redeliver',
    profile: 'BodylessNonceMutation',
    signedResponse: true,
    routeId: 'partner.webhook-events.redeliver',
    scope: null,
    walletBound: false,
  },
] as const satisfies readonly PartnerRoute[];

/**
 * Reports whether a concrete request path is an instance of a route template.
 *
 * @remarks Each placeholder stands for exactly one non-empty path segment. The transport uses this to keep a route's
 * declared answer signing bound to the path actually sent, so a mislabelled call cannot borrow an unsigned route.
 */
export function pathMatchesTemplate(template: string, pathname: string): boolean {
  const expected = template.split('/');
  const actual = pathname.split('/');
  if (expected.length !== actual.length) return false;
  return expected.every((segment, index) => {
    const received = actual[index] ?? '';
    return /^\{[A-Za-z]+\}$/.test(segment) ? received.length > 0 : segment === received;
  });
}
