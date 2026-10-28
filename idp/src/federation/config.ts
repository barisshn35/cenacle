// SPDX-License-Identifier: AGPL-3.0-only
// Settings of the identity providers people may sign in with.
import { z } from 'zod';

const groupList = z.array(z.string().min(1).max(200)).max(50).default([]);

/** What both kinds share: how people and their roles are taken over. */
const common = {
  /**
   * An existing account with the same verified e-mail address becomes this
   * provider's account. Only for providers that verify addresses.
   */
  linkByEmail: z.boolean().default(false),
  /** People in one of these groups administer Cenacle (role admin). */
  adminGroups: groupList,
  /** People in one of these groups are guests (role guest). */
  guestGroups: groupList,
};

export const oidcConfigSchema = z.object({
  /** The provider's issuer; its discovery document is at /.well-known/openid-configuration. */
  issuer: z.url({ protocol: /^https?$/ }).max(500),
  clientId: z.string().min(1).max(500),
  scopes: z
    .string()
    .max(500)
    .regex(/^[\x21-\x7e]+( [\x21-\x7e]+)*$/)
    .default('openid email profile'),
  /** The claim with the person's groups (an array of names). */
  groupsClaim: z
    .string()
    .max(100)
    .regex(/^[A-Za-z0-9_.:-]*$/)
    .default('groups'),
  /**
   * The provider vouches for the e-mail addresses it pushes over SCIM (SCIM has
   * no verified flag; sign-ins carry email_verified).
   */
  scimTrustEmail: z.boolean().default(false),
  ...common,
});
export type OidcConfig = z.infer<typeof oidcConfigSchema>;

export const samlConfigSchema = z.object({
  /** The identity provider's single sign-on URL (HTTP-Redirect binding). */
  entryPoint: z.url({ protocol: /^https?$/ }).max(2000),
  /** The identity provider's entity id: responses must come from it. */
  idpEntityId: z.string().min(1).max(500),
  /** Its signing certificate(s), PEM (several during a rollover). */
  idpCert: z
    .string()
    .min(1)
    .max(40_000)
    .refine((v) => v.includes('BEGIN CERTIFICATE'), 'PEM certificate'),
  /** Attribute names; empty takes the NameID (id) or nothing. */
  emailAttribute: z
    .string()
    .max(200)
    .default('http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'),
  nameAttribute: z
    .string()
    .max(200)
    .default('http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'),
  groupsAttribute: z
    .string()
    .max(200)
    .default('http://schemas.microsoft.com/ws/2008/06/identity/claims/groups'),
  /** The provider vouches for the addresses it sends, at sign-ins and over SCIM (SAML has no verified flag). */
  trustEmail: z.boolean().default(false),
  ...common,
});
export type SamlConfig = z.infer<typeof samlConfigSchema>;

export type ProviderKind = 'oidc' | 'saml';
