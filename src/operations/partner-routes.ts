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
}

/**
 * Closed route table held against the published OpenAPI contract by drift tests.
 *
 * @remarks A local route can drift in either direction: an invented route may be refused, while an omitted published
 * route leaves a partner unable to reach part of the API. The drift test checks both, along with each route's signing
 * profile and whether its answers are signed.
 */
export const PARTNER_ROUTES = [
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
  { method: 'GET', template: '/v1/wallets/{walletId}/cards', profile: 'SafeRead', signedResponse: false },
  { method: 'GET', template: '/v1/wallets/{walletId}/cards/{soldCardId}', profile: 'SafeRead', signedResponse: false },
  {
    method: 'POST',
    template: '/v1/wallets/{walletId}/cards/{soldCardId}/reveal',
    profile: 'BodylessNonceMutation',
    signedResponse: true,
  },
  {
    method: 'POST',
    template: '/v1/wallets/{walletId}/invoices/{invoiceId}/cards/reveal',
    profile: 'BodylessNonceMutation',
    signedResponse: true,
  },
  { method: 'POST', template: '/v1/diagnostics/signature', profile: 'BodylessNonceMutation', signedResponse: true },
  { method: 'GET', template: '/v1/enrollments/{invitationId}', signedResponse: true },
  { method: 'POST', template: '/v1/enrollments/{invitationId}/keys', signedResponse: true },
  { method: 'POST', template: '/v1/enrollments/{invitationId}/proof', signedResponse: true },
  { method: 'GET', template: '/v1/enrollments/{invitationId}/status', signedResponse: true },
  { method: 'GET', template: '/.well-known/partner-signing-keys.json', signedResponse: false },
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
