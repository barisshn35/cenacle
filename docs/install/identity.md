# Identity: directories, identity providers, passkeys and groups

Everything here is set up in the **Cenacle ID admin panel** at
`https://<id-domain>/account/admin`. Only Cenacle ID administrators reach it. To make an
account an administrator:

```sh
docker compose -f prod.yml --env-file .env.prod run --rm idp \
  node dist/cli.js users admin --email you@example.com
```

People of a directory's admin filter, or of an identity provider's administrator groups,
are administrators of the chat (they create workspaces); Cenacle ID administration stays
with the accounts given it above.

## Active Directory and LDAP

**Administration → Directories → Connect a directory**, choose _Active Directory_ or
_OpenLDAP_. The presets fill in the usual attributes; check them against your directory.

| Setting                | Active Directory example                                                 |
| ---------------------- | ------------------------------------------------------------------------ |
| Server addresses       | `ldaps://dc1.example.com:636` (one per line, tried in order)             |
| Service account        | `CN=svc-cenacle,OU=Service,DC=example,DC=com` and its password           |
| Search base            | `OU=People,DC=example,DC=com`                                            |
| Who may sign in        | `(&(objectClass=user)(!(userAccountControl:1.2.840.113556.1.4.803:=2)))` |
| Sign-in name attribute | `sAMAccountName` (or `userPrincipalName`)                                |
| Stable id attribute    | `objectGUID` (OpenLDAP: `entryUUID`); never a name or an address         |
| Groups                 | a filter such as `(objectClass=group)`; nested groups are resolved       |
| Administrators, guests | filters, e.g. `(memberOf=CN=Cenacle Admins,OU=Groups,DC=example,DC=com)` |

- The service account only needs read access. Passwords of people are checked by binding
  as them and are never stored.
- The saved service account password is never shown and is only sent where it was entered
  for: changing the server addresses, the service account or the TLS settings asks for it
  again.
- Use `ldaps://` or StartTLS. Paste your CA certificate (PEM) if the directory's certificate
  is not issued by a public CA.
- **Test the connection** and **Preview a person** before turning the directory on.
- People sign in with their sign-in name or e-mail address and their directory password.
- **Synchronization** runs at the interval you set (and after **Synchronize now**): people
  and groups are refreshed; people the filter no longer admits are deactivated in Cenacle ID
  and in the chat within a minute, and all their sessions end. If a synchronization finds
  nobody (a wrong filter, an empty search base), nothing is deactivated.
- A local account with the same e-mail address becomes the directory's account.
- Disabling a directory account in **Accounts** (or with `cenacle-idp users disable`) blocks it
  in Cenacle ID whatever the directory says: synchronizations and directory sign-ins keep it
  disabled until an administrator enables it again.

Allow outbound 389/tcp or 636/tcp (3268/3269 for a Global Catalog) from the `idp`
container.

## Identity providers (OpenID Connect, SAML 2.0)

**Administration → Identity providers.** The sign-in pages then offer
"Continue with _name_".

### OpenID Connect (Entra ID, Okta, Keycloak, Google Workspace, …)

1. Add an OpenID Connect provider with its name, issuer URL, client id and secret, and save.
2. Register the **Redirect URI** the page shows
   (`https://<id-domain>/federation/<id>/callback`) as a web application at the provider.
3. Groups: name the claim that lists them (`groups` by default). Entra ID sends group ids
   unless the app is set to send names (or use app roles with the `roles` claim).
4. The saved client secret is never shown and goes only to the issuer it was entered for:
   changing the issuer or the client id asks for it again.

### SAML 2.0 (AD FS, Entra ID, Okta, Shibboleth, …)

1. Add a SAML 2.0 provider with its single sign-on URL, entity id and signing certificate
   (PEM; paste both certificates during a rollover), and save.
2. Register Cenacle ID at the provider with the **entity id**, the **assertion consumer
   service URL** (HTTP-POST) or the **metadata** URL the page shows.
3. The provider must sign assertions and send a **persistent** NameID; transient ids make a
   new account at every sign-in. Name the e-mail, display name and groups attributes.
4. Only sign-ins that start at Cenacle ID are accepted (no IdP-initiated sign-in).

### Accounts of providers

- Accounts are created at the first sign-in; name, address, groups and role come with every
  sign-in.
- **Link by e-mail** makes an existing account with the same address the provider's — only
  when the provider vouches for the address (OIDC `email_verified`; for SAML, the "vouches
  for the e-mail addresses" setting). Turn it on only for providers that verify addresses.
  Administrators of Cenacle ID and accounts with a two-step code are never linked: provider
  sign-ins skip the second step, so such a person gets a separate provider account.
- Without provisioning, providers do not tell Cenacle ID when someone leaves: block them at
  the provider (they can no longer sign in) and disable their account in **Accounts** to end
  their sessions. With SCIM (below) the provider does this itself. An account an
  administrator disabled stays disabled whatever the provider pushes over SCIM.

### Provisioning (SCIM 2.0)

With SCIM the provider creates, changes and deactivates its people and groups in Cenacle ID
before they sign in; deactivating someone there ends their sessions within a minute.

1. On the provider's page in **Administration → Identity providers**, choose **Turn on and
   create a token**. Copy the token: it is shown once.
2. At the provider, add a SCIM 2.0 application (Entra ID: _Enterprise application →
   Provisioning_; Okta: _SCIM provisioning_; Keycloak: a SCIM extension) with the **SCIM
   base URL** shown (`https://<id-domain>/scim/v2`) and the token as the bearer token.
3. Map `userName`, `emails`, `displayName` (or `name`), `active` and, for groups,
   `displayName` and `members`. `externalId` is optional.

- People are matched at their first sign-in by their verified e-mail address and are then
  bound to the provider's id, once (a bound account never moves to another id); someone who
  signed in before provisioning started is taken over when the provider pushes them.
- SCIM carries no verified flag: pushed addresses are kept **unverified** unless the provider
  vouches for them (SAML: "vouches for the e-mail addresses it sends"; OIDC: "vouches for
  the e-mail addresses it provisions over SCIM"). Only a vouched address links a local
  account (with **Link by e-mail**), and administrators of Cenacle ID and accounts with a
  second step are never linked this way: their address makes the push a conflict (409).
- With SCIM on, **groups come from SCIM**, not from sign-ins. The administrator and guest
  groups of the provider still decide roles.
- Deleting a person over SCIM deactivates the account (their messages keep their author).
- A new token replaces the old one; **Turn off** stops provisioning and keeps the accounts.

## Passkeys

People add passkeys at `https://<id-domain>/account` and then sign in with their
fingerprint, face or device PIN instead of a password. A passkey counts as two factors (no
code is asked). Passkeys are bound to Cenacle ID's host name: changing it later makes
existing passkeys stop working.

## Groups in the chat

- **Workspace settings → Directory groups** (owners and admins): people of a group join the
  workspace with the role chosen (admin, member, guest), at sign-in and within a minute of
  a directory change. Removing the mapping or leaving the group takes the membership back.
- **Channel settings → Directory groups** (managers of private channels): people of the
  groups join the channel. With _Members are exactly the people of these groups_ the
  channel is managed by groups: nobody joins, leaves or is added by hand.
- **Guests** (the guest filter or guest groups) see only the channels they are in and the
  people in them. They are never added to default channels.

Directory (LDAP) groups are named as in the directory; an identity provider's groups as
`<provider>/<group>` (for example `Entra ID/Engineering`), so a provider can never name a
group like the directory's or another provider's. Map those with the prefix.

The chat reads groups through the `groups` scope and the directory feed; its client in
`deploy/compose/idp/clients.json` must have `"scope": "openid email profile groups"` and
`"directory_feed": true` (as shipped).
