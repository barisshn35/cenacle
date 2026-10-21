# SPDX-License-Identifier: Apache-2.0
# Cenacle ID (identity server). Build from the repository root:
#   docker build -f idp/Dockerfile -t cenacle-idp .

# Dependencies are pure JavaScript, so the build runs on the native build
# platform (no emulation for arm64); only the node binary is target-specific.
FROM --platform=$BUILDPLATFORM node:24.22.0-alpine3.24 AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY idp/package.json idp/
COPY packages/ui/package.json packages/ui/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @cenacle/idp...
# Design tokens for the sign-in pages come from @cenacle/ui.
COPY packages/ui/src/styles/ packages/ui/src/styles/
COPY idp/ idp/
RUN pnpm --filter @cenacle/idp build \
 && pnpm --filter @cenacle/idp deploy --prod /out \
 && rm -rf /out/src /out/test /out/tsconfig*.json /out/vitest.config.ts /out/Dockerfile

# The node binary for the target platform.
FROM node:24.22.0-alpine3.24 AS node

# Runtime: plain Alpine plus the node binary only (no npm/corepack/yarn):
# smaller image and smaller attack surface.
FROM alpine:3.24.2
RUN apk add --no-cache libstdc++ libgcc \
 && addgroup -g 1000 node && adduser -u 1000 -G node -s /sbin/nologin -D node
COPY --from=node /usr/local/bin/node /usr/local/bin/node
ENV NODE_ENV=production \
    IDP_ENV=production \
    IDP_HOST=0.0.0.0 \
    IDP_PORT=8190
WORKDIR /app
COPY --from=build --chown=root:root /out ./
EXPOSE 8190
# Unprivileged "node" user (uid 1000); application files stay read-only for it.
USER node
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.IDP_PORT||8190)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# Maintenance commands: docker compose run --rm idp node dist/cli.js <migrate|keys|users> ...
CMD ["node", "--enable-source-maps", "dist/server.js"]
