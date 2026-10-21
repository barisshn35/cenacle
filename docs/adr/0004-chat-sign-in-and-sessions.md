# 0004. Chat sign-in and sessions (v0.3)

- Status: accepted
- Date: 2026-10-21

## Context

v0.3 signs users in to the chat with Cenacle ID. The kickoff fixes the Mattermost model:
the chat server is a confidential OIDC client, maps users by the IdP subject and then
issues its own opaque sessions; the IdP's tokens are not used after sign-in. Web uses an
`HttpOnly` cookie, other clients (desktop, v1.1) a bearer token. The API is spec-first.

## Decisions

1. **Spec-first API.** `server/api/openapi.yaml` is the contract. `oapi-codegen` (pinned,
   installed by `make tools`) generates the chi server interface and models into
   `internal/api`; `openapi-typescript` generates the client types in `@cenacle/core`. CI
   fails when generated code is out of date.
2. **Authorization code flow with PKCE.** `go-oidc` and `x/oauth2`; client authentication
   `client_secret_basic` (ADR 0002). Every sign-in has its own `state`, `nonce` and PKCE
   verifier. The ID token is verified (signature via JWKS, issuer, audience, expiry, nonce);
   e-mail and name come from userinfo, whose subject must equal the ID token's. The `iss`
   parameter of the authorization response is checked (RFC 9207, mix-up defense).
3. **Sign-in state in Valkey, bound to the browser.** The verifier, nonce and return path
   are stored under the `state` with `SET NX` for 15 minutes (the IdP's interaction
   lifetime) and read with `GETDEL`, so a callback works once. The `state` is also set in a
   short-lived `HttpOnly` cookie; a callback whose `state` differs from the cookie is
   rejected (login CSRF: an attacker cannot make a victim's browser finish the attacker's
   sign-in).
4. **Return path.** `return_to` must be a path inside the app (starts with `/`, not `//`
   or `/\`, no control characters), otherwise `/`. Failures redirect to
   `/signin?error=<cancelled|expired|failed|unavailable>`; the web app explains each one.
5. **Users.** `users(auth_service, auth_data)` is the key (`cenacle-id`, subject). E-mail,
   verification flag and display name are refreshed at every sign-in; e-mail is not a key.
   IDs are `uuidv7()` (PostgreSQL 18).
6. **Sessions.** 256-bit random tokens (base64url), stored as SHA-256: a slow hash adds
   nothing for tokens of this entropy and would cost on every request. Lifetime: idle
   timeout 7 days and absolute maximum 30 days (`CENACLE_SESSION_IDLE_TIMEOUT`,
   `CENACLE_SESSION_MAX_AGE`). Use is recorded at most once a minute; expired sessions are
   deleted every 10 minutes. User agent and client address are kept for the session list
   of v0.8.
7. **Cookie.** `cenacle_session`, `HttpOnly`, `SameSite=Lax`, `Path=/`, host-only, and over
   https `Secure` with the `__Host-` prefix (a sibling subdomain cannot set or shadow it).
   `Lax` is needed for the top-level redirect back from Cenacle ID; it already keeps the
   cookie off cross-site subrequests and form posts.
8. **CSRF.** State-changing requests authenticated by the cookie must carry an `Origin`
   equal to the app origin, or `Sec-Fetch-Site: same-origin` when no `Origin` is sent.
   Requests with `Authorization: Bearer` are not exposed to CSRF and skip the check.
9. **Same origin for app and API.** Production serves `/api` through Caddy on the app host;
   development proxies `/api` through the Vite dev server. No CORS is needed, and the cookie
   never has to cross origins. The OIDC redirect URI derives from `CENACLE_PUBLIC_URL`.
10. **Back channel.** Server-to-IdP requests (discovery, token, userinfo, JWKS) can go to
    an internal address (`CENACLE_OIDC_BACKCHANNEL_URL=http://idp:8190` in the Compose
    stack): requests to the public issuer origin are rewritten, keeping the public `Host`
    and `X-Forwarded-Proto`, so the IdP sees what it would see through the proxy and the
    issuer check still uses the public URL. The host does not need to reach its own public
    address (no hairpin NAT).
11. **Lazy discovery.** The server starts without Cenacle ID and discovers it on the first
    sign-in, retrying until it succeeds; `/readyz` does not depend on the IdP.
12. **Sign-out.** `POST /api/auth/logout` deletes the session and clears the cookie, then
    the web app opens the IdP's end-session page (`client_id` and
    `post_logout_redirect_uri`), which asks whether to end single sign-on on this device.
    Back-channel logout and session management follow in v0.8.
13. **Web app.** A pathless layout route requires a session: the router checks
    `GET /api/session` before rendering and sends signed-out users to `/signin` with the
    current location. A session that ends while the app is open leads to the same page with
    "Your session has ended"; drafts stay in IndexedDB. A server that cannot be reached is
    shown as such, with a retry, and does not sign the user out.
14. **Tests.** Go integration tests drive the whole flow against a fake OpenID Provider and a
    PostgreSQL test database (`CENACLE_TEST_DATABASE_URL`): PKCE, nonce, issuer, login
    CSRF, replay, return path, expiry, bearer tokens, CSRF. `make test-e2e-stack` runs
    Cenacle ID, the chat server and the web app as real processes and signs in and out in
    Chromium; it runs in CI.

## Consequences

- Every API request with a session costs one indexed lookup in PostgreSQL. A Valkey cache
  can be added in v0.13 if load tests ask for it.
- Sign-in starts are not rate limited yet; each one stores about 300 bytes in Valkey for at
  most 15 minutes. Request limits for the chat API come with v0.13.
- Signing out in the chat does not yet end other chat sessions of the user; "sign out
  everywhere" is part of session management (v0.8).
- Development must use `http://localhost:5173` (the host name in `CENACLE_PUBLIC_URL`), not
  `127.0.0.1`, because cookies are bound to host names.
