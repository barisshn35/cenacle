# 0017. Directories, identity providers, passkeys and guests (v0.14)

- Status: accepted
- Date: 2026-10-22

## Context

Organisations bring their people from a company directory (Active Directory, OpenLDAP) or
an identity provider they already run (Microsoft Entra ID, Okta, Keycloak, Google
Workspace, AD FS). Their groups decide who joins which workspace and channel, who
administers and who is only a guest. People also expect passwordless sign-in. All of this
must stay in Cenacle ID (the chat server only trusts its tokens, ADR 0004) and work across
several instances (ADR 0016).

## Decisions

1. **Identity sources in Cenacle ID.** One table, `identity_sources`, holds directories
   (`ldap`) and identity providers (`oidc`, `saml`), with settings as JSON and the secret
   (bind password, client secret) encrypted with `IDP_KEY_ENCRYPTION_KEY`, bound to the
   source id. Accounts keep `(source_id, external_id)`: the directory's `objectGUID` /
   `entryUUID`, the provider's `sub` or SAML NameID. E-mail is not the key (ADR 0004).
2. **LDAP with `ldapts`** (MIT). A service account searches; the person's password is
   checked by binding as them and never stored; empty passwords are refused. Nested groups
   (member DNs, resolved breadth-first) and posixGroup `memberUid` are supported; admin and
   guest roles come from LDAP filters. Sign-in accepts the login attribute (e.g.
   `sAMAccountName`) or an e-mail address.
3. **Synchronization.** Every minute a job (PostgreSQL advisory lock: one instance at a time)
   synchronizes each directory whose interval has passed: people and groups are written,
   people the filter no longer admits are deactivated and their Cenacle ID sessions and
   grants end. A sync that finds nobody is refused instead of deactivating everyone. A local
   account with the same address becomes the directory's account (the directory is
   authoritative).
4. **Identity providers.** OpenID Connect with `openid-client` (MIT): discovery, the
   authorization code flow with PKCE, state and nonce, userinfo when the ID token lacks the
   address or groups. SAML 2.0 with `node-saml` (MIT): HTTP-Redirect requests, a signed
   assertion is required, only answers to our own request ids are accepted (stored in the
   database, so every instance knows them; no IdP-initiated sign-in), service provider
   metadata at `/federation/:id/metadata`. A sign-in on its way is a database row found by
   its state, bound to the browser that started it (a `SameSite=Lax` cookie whose hash is
   stored) and to its interaction; it is finished once.
5. **Account linking is opt-in.** A provider's person gets a new account unless the
   provider is set to link by e-mail **and** vouches for the address (OIDC
   `email_verified`, or a SAML provider marked as trusted). Accounts an administrator
   disabled stay disabled; providers have no deactivation feed, so administrators disable
   their people in the admin panel (or in the provider, which stops new sign-ins).
6. **Passkeys with SimpleWebAuthn** (MIT): discoverable credentials with user
   verification, so a passkey is two factors and no second step follows. Challenges are
   single-use, live five minutes and are bound to the interaction or the account; a lower
   signature counter (a cloned authenticator) is refused. The relying party is Cenacle ID's
   host, so a passkey works for every app. The browser library is served from our assets.
7. **Admin panel at `/account/admin`**, server-rendered like the other Cenacle ID pages,
   for Cenacle ID administrators (`users.is_admin`, given with the CLI or in the panel; a
   directory's admin filter and a provider's admin groups make chat administrators, not
   Cenacle ID ones): accounts (disable, enable, reset two-step verification,
   administrators), directories (test, preview a person, synchronize, history) and
   identity providers.
8. **Groups reach the chat** as the `groups` and `cenacle_role` claims (scope `groups`) at
   sign-in, and between sign-ins through a directory feed (`/directory/v1/changes`, Basic
   auth, only for clients registered with `directory_feed`) that the chat server polls
   every minute: changed people, their groups and whether they are disabled. A disabled
   person is deactivated in the chat, every session ends and their pending scheduled
   messages are canceled (a deactivated author is also refused when one comes due).
9. **Mappings in the chat.** Workspace owners and admins map directory groups to the
   workspace with a role (admin, member, guest); managers of private channels give them
   groups, optionally _managed_: then the members are exactly the people of the groups and
   nobody joins, leaves or is added by hand. Memberships from groups carry `via_group` so a
   group change takes back only what it gave.
10. **Guests** see only the channels they are in and the people in them: no public channel
    list, no joining, no conversations with others, never default channels. Several
    instance administrators are allowed (the configured one and the directory's).

## Consequences

- Clients that want groups request the `groups` scope; the chat client must be registered
  with that scope and `directory_feed` (see the upgrade notes).
- SCIM provisioning and outbound SAML (Cenacle ID as a SAML IdP for other apps) are not in
  this release; deprovisioning of provider accounts is by sign-in failure at the provider
  or by an administrator until then.
- A SAML provider that sends transient NameIDs makes a new account at every sign-in:
  providers must send a persistent identifier.
