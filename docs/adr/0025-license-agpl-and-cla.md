# 0025. License: AGPL-3.0 with a CLA (after v0.20)

- Status: accepted
- Date: 2026-10-22
- Supersedes the default license of ADR 0001 (Apache-2.0).

## Context

Cenacle is meant to stay open and self-hosted, and its maintainer intends to fund it later
with a supported enterprise edition, support contracts and hosting. A permissive license
lets anyone run a closed fork as a service without giving changes back. Mattermost,
Rocket.Chat-like products and Element/Synapse have chosen the AGPL or a dual model for the
same reason.

## Decisions

1. **The server, Cenacle ID (idp), the web app and `packages/ui` are under the GNU Affero
   General Public License v3.0 only** (`AGPL-3.0-only`, root `LICENSE`). Whoever offers a
   modified version to users over a network must offer them its source.
2. **`packages/core`, the API and WebSocket client, stays under the Apache License 2.0**
   (`packages/core/LICENSE`), so bots, integrations and other clients can embed it under
   any license. The API itself (OpenAPI document) is part of the server.
3. **Contributions need a CLA** (`CLA.md`, modeled on the Apache ICLA/CCLA): contributors
   keep their copyright and grant broad copyright and patent licenses, which allow the
   maintainer to offer the code under other terms too (e.g. a commercial edition). Signing
   is a line in `cla/signatures.txt` added in a signed-off commit; CI checks every commit of
   a merge request (`ci/check-cla.sh`) for a sign-off (DCO) and a signature.
4. **The name and logo are trademarks** with a written policy (`TRADEMARKS.md`): modified
   versions are distributed under another name.
5. **Dependencies stay permissive** (ADR 0001): AGPL code may use them, and keeping them
   permissive keeps a future commercial edition possible. Separate AGPL services (Garage)
   remain separate processes.
6. Every source file's SPDX header names its license; images carry the
   `org.opencontainers.image.licenses` label.

## Consequences

- Releases up to and including 0.20.0 remain available under Apache-2.0; later releases
  are AGPL-3.0-only.
- The repositories become public with v1.0 (web and desktop); until then the code is
  shared privately.
- Companies that cannot accept the AGPL need a commercial license, which the CLA makes
  possible to offer.
