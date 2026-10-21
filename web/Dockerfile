# SPDX-License-Identifier: Apache-2.0
# Cenacle web app: static build served by Caddy. Build from the repository root:
#   docker build -f web/Dockerfile -t cenacle-web .

FROM --platform=$BUILDPLATFORM node:24.22.0-alpine3.24 AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY web/package.json web/
COPY packages/ui/package.json packages/ui/
COPY packages/core/package.json packages/core/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @cenacle/web...
COPY packages/ packages/
COPY web/ web/
RUN pnpm --filter @cenacle/web exec vite build

FROM caddy:2.11.7-alpine
COPY web/deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/web/dist /srv
# Unprivileged user; port 8080 needs no capabilities.
# Port 8080 needs no capability; removing the binary's file capability lets the
# container run with cap_drop ALL and no-new-privileges.
RUN apk add --no-cache libcap && setcap -r /usr/bin/caddy && apk del libcap \
 && adduser -D -H -u 10001 cenacle \
 && chown -R cenacle:cenacle /data /config
USER cenacle
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD ["wget", "-qO-", "http://127.0.0.1:8080/healthz"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
