# 0002. Cenacle ID core (v0.2)

- Status: accepted
- Date: 2026-10-21

## Context

v0.2 turns the IdP skeleton into an OpenID Provider. The chat server will sign users in
with it in v0.3 (confidential client, authorization code + PKCE) and then issue its own
sessions. The kickoff fixes `node-oidc-provider` v9, Argon2id, the RFC 9700 profile and
JWKS rotation with old and new keys published together.

## Decisions

1. **oidc-provider 9 on Fastify without middleware adapters.** OIDC paths
   (`/.well-known/*`, `/auth`, `/token`, `/me`, `/jwks`, `/session/end`, `/request`) are
   handed to `provider.callback()` in an `onRequest` hook with `reply.hijack()`, before
   Fastify parses the body. Everything else stays Fastify (problem details, request IDs,
   health probes, sign-in pages). No extra dependency such as `@fastify/middie`.
2. **RFC 9700 profile.** Response type `code` only; PKCE (S256) required for every client
   (the library default only requires it for public clients); `redirect_uri` must always
   be sent and match exactly; client authentication `client_secret_basic` only; codes 60 s,
   access and ID tokens 10 min, interactions 15 min, IdP sessions 7 days. No refresh tokens
   unless `offline_access` is granted (not offered yet).
3. **ID token claims follow OIDC Core.** In the code flow the ID token carries identity
   (`sub`, `iss`, `aud`, times); e-mail and profile claims come from userinfo
   (`conformIdTokenClaims`). The chat server reads userinfo once at sign-in.
4. **Clients are configuration.** `IDP_CLIENTS_FILE` (JSON) lists confidential clients;
   secrets live in separate files; `${VARIABLE}` placeholders (e.g. `${CENACLE_DOMAIN}`)
   keep host names out of the file. Only `https` redirect URIs (or `http` to loopback),
   no fragments. First-party clients receive their grant without a consent screen; there
   is no consent UI for third-party clients yet.
5. **PostgreSQL storage.** One `oidc_payloads` table for every provider model, indexed by
   grant, uid and user code; expired rows are ignored on read and pruned every 10 minutes.
6. **Signing keys: RS256 (RSA-3072), encrypted at rest.** Private JWKs are sealed with
   AES-256-GCM using `IDP_KEY_ENCRYPTION_KEY` (32 bytes, a secret outside the database); the
   key id is bound as AAD. One active key per algorithm (unique partial index). The first
   key is created on startup under an advisory lock. `cenacle-idp keys rotate` makes a new
   active key and keeps the previous one published for `IDP_KEY_RETIRED_GRACE_SECONDS`
   (default 7 days); `keys prune` deletes older ones. Changes apply when Cenacle ID restarts.
7. **Passwords: Argon2id via `@node-rs/argon2`.** OWASP parameters (19 MiB, t=2, p=1),
   stored in each hash so they can be raised later. Policy per NIST SP 800-63B-4: at least
   15 characters while a password is the only factor, no composition rules, up to 256
   characters, NFC normalised. Unknown, disabled and password-less accounts fail exactly
   like a wrong password and still pay for a hash check (no account enumeration by timing).
8. **Accounts are created by operators** (`cenacle-idp users create|set-password|disable|enable`,
   passwords from stdin). Self-registration, MFA and directory accounts come later
   (v0.8, v0.14).
9. **Sign-in pages are server-rendered HTML** built with an escaping template helper, the
   shared design tokens (`@cenacle/ui/tokens.css`, compiled with Tailwind) and bundled
   Geist fonts. The only script sets theme and density from media queries. They replace the
   provider's default pages, which load Google Fonts. CSP: `default-src 'none'`, scripts,
   styles, fonts and images from self; `form-action` allows self plus the registered client
   origins because browsers apply it to the redirects after a form post.
10. **Form protection.** Sign-in and cancel posts must come from our origin:
    `Sec-Fetch-Site: same-origin`, or an `Origin` equal to the issuer origin. Pages use
    `Referrer-Policy: same-origin` (with `no-referrer`, browsers send `Origin: null` on
    form posts). Interaction cookies are signed, `HttpOnly`, `SameSite=Lax` and `Secure`
    behind the proxy (`IDP_TRUST_PROXY`).
11. **Rate limiting** with `@fastify/rate-limit`: 10 sign-in posts per IP and minute, in
    memory. Several replicas need a shared store (Valkey), planned for v0.13.
12. **Migrations** for the IdP use `node-pg-migrate` (SQL files) in one transaction under an
    advisory lock in _wait_ mode, so replicas that start together do not fail.
13. **Testing.** Integration tests run against a dedicated PostgreSQL database
    (`cenacle_idp_test` in development, a service container in CI). End-to-end tests start
    Cenacle ID in-process and drive the full flow with Playwright and `openid-client`,
    including key rotation, logout, rate limiting, target sizes and axe.
14. **Supply chain.** pnpm installs native binaries for linux x64/arm64 and glibc/musl so an
    amd64 build host produces working arm64 images; the `@parcel/watcher` install script is
    denied. `BlueOak-1.0.0` (permissive, OSI approved; used by `glob`) is an allowed license.

## Consequences

- Production needs three more secrets (`gen-secrets.sh` creates them): key encryption key,
  cookie keys and the chat client secret. Losing the key encryption key makes stored signing
  keys unusable: back it up with the database.
- Key rotation needs a restart of Cenacle ID; automatic rotation is a later improvement.
- Sign-in rate limits are per instance until v0.13.
