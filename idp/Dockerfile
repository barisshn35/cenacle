# SPDX-License-Identifier: AGPL-3.0-only
# Cenacle ID (identity server). Build from the repository root:
#   docker build -f idp/Dockerfile -t cenacle-idp .
# FIPS 140-3 (node with OpenSSL's validated FIPS provider 3.1.2, CMVP #4985):
#   docker build -f idp/Dockerfile --target fips -t cenacle-idp-fips .

# Dependencies are pure JavaScript, so the build runs on the native build
# platform (no emulation for arm64); only the node binary is target-specific.
FROM --platform=$BUILDPLATFORM node:26.13.0-alpine3.24@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216 AS build
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
# pnpm, the version package.json's packageManager names, from the npm registry
# (Node.js ships no Corepack since 25); a slow registry should not fail the
# build: try a few times.
RUN for i in 1 2 3 4; do npm install -g "$(node -p 'require("./package.json").packageManager')" && pnpm --version && exit 0; echo "pnpm install failed ($i), retrying"; sleep $((i * 10)); done; exit 1
COPY idp/package.json idp/
COPY packages/ui/package.json packages/ui/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @cenacle/idp...
# Design tokens for the sign-in pages come from @cenacle/ui.
COPY packages/ui/src/styles/ packages/ui/src/styles/
COPY idp/ idp/
COPY scripts/third-party-notices.* scripts/
COPY LICENSE /out-licenses/LICENSE
# The notices: the production dependencies, and what the sign-in pages serve
# from development dependencies (fonts, the browser half of SimpleWebAuthn).
RUN pnpm --filter @cenacle/idp build \
 && node scripts/third-party-notices.mjs pnpm @cenacle/idp @fontsource-variable/geist \
      @fontsource-variable/geist-mono @simplewebauthn/browser > /out-licenses/THIRD_PARTY_NOTICES.txt \
 && pnpm --filter @cenacle/idp deploy --prod /out \
 && rm -rf /out/src /out/test /out/tsconfig*.json /out/vitest.config.ts /out/Dockerfile \
      /out/node_modules/.modules.yaml /out/node_modules/.pnpm-workspace-state-v1.json

# The node binary for the target platform.
FROM node:26.13.0-alpine3.24@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216 AS node

# OpenSSL's FIPS provider, built from the validated 3.1.2 sources (only the
# provider is used; node keeps its own OpenSSL library).
FROM alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a AS fips-provider
RUN apk add --no-cache build-base perl linux-headers
WORKDIR /build
ADD --checksum=sha256:a0ce69b8b97ea6a35b96875235aa453b966ba3cba8af2de23657d8b6767d6539 \
    https://github.com/openssl/openssl/releases/download/openssl-3.1.2/openssl-3.1.2.tar.gz /build/
RUN tar xzf openssl-3.1.2.tar.gz && cd openssl-3.1.2 \
 && ./Configure enable-fips --prefix=/usr/local --libdir=lib --openssldir=/usr/local/ssl >/dev/null \
 && make -j"$(nproc)" >/dev/null \
 && make install_fips DESTDIR=/out >/dev/null

# Runtime: plain Alpine plus the node binary only (no npm, pnpm or yarn):
# smaller image and smaller attack surface.
FROM alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a AS runtime
RUN apk add --no-cache libstdc++ libgcc libatomic \
 && addgroup -g 1000 node && adduser -u 1000 -G node -s /sbin/nologin -D node \
 && rm -f /var/log/apk.log
COPY --from=node /usr/local/bin/node /usr/local/bin/node
ENV NODE_ENV=production \
    IDP_ENV=production \
    IDP_HOST=0.0.0.0 \
    IDP_PORT=8190
WORKDIR /app
COPY --from=build --chown=root:root /out ./
COPY --from=build /out-licenses /licenses
EXPOSE 8190
# Unprivileged "node" user (uid 1000); application files stay read-only for it.
# Numeric, so Kubernetes can check runAsNonRoot.
USER 1000:1000
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.IDP_PORT||8190)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# Maintenance commands: docker compose run --rm idp node dist/cli.js <migrate|keys|users> ...
# The V8 of Node.js 26 aborts the process on a lazy deoptimization after a fast API
# call (Buffer.byteLength in res.end; nodejs/node#66870): those calls stay off.
CMD ["node", "--no-turbo-fast-api-calls", "--enable-source-maps", "dist/server.js"]

# The FIPS variant: node loads the FIPS provider and allows FIPS-approved
# algorithms only (default property fips=yes); passwords use PBKDF2.
FROM runtime AS fips
COPY --from=fips-provider /out/usr/local/lib/ossl-modules/fips.so /usr/local/lib/ossl-modules/fips.so
COPY --from=fips-provider /out/usr/local/ssl/fipsmodule.cnf /etc/ssl/fipsmodule.cnf
COPY idp/fips/openssl.cnf /etc/ssl/cenacle-fips.cnf
ENV OPENSSL_CONF=/etc/ssl/cenacle-fips.cnf \
    OPENSSL_MODULES=/usr/local/lib/ossl-modules
USER 1000:1000
CMD ["node", "--no-turbo-fast-api-calls", "--enable-fips", "--enable-source-maps", "dist/server.js"]

# The default image (the last stage).
FROM runtime
USER 1000:1000
