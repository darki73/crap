# Build CRAP only. CLIProxyAPI is installed independently from its official distribution.
FROM golang:1.27.2-bookworm@sha256:5cf287a799e6b94384bad13d16b14904c531f51ba65792237e122ce42b392f61 AS go-base
WORKDIR /src

FROM go-base AS affinity-build
COPY affinity-router/go.mod affinity-router/go.sum ./
RUN go mod download
COPY affinity-router/ ./
RUN CGO_ENABLED=1 go build -buildmode=c-shared -o /out/affinity-router.so ./cmd/affinity-plugin && \
    CGO_ENABLED=0 go build -o /out/affinity-control ./cmd/affinity-control && \
    CGO_ENABLED=0 go build -o /out/affinity-db ./cmd/affinity-db && \
    CGO_ENABLED=0 go build -o /out/affinity-gateway ./cmd/affinity-gateway

FROM go-base AS tailnet-build
COPY control-panel/tailnet-gateway/ ./
RUN CGO_ENABLED=0 go build -o /out/tailnet-gateway . && \
    CGO_ENABLED=0 go build -o /out/lan-gateway ./cmd/lan-gateway

FROM node:24-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66 AS ui-build
WORKDIR /src
COPY control-panel/package*.json ./
RUN npm ci
COPY control-panel/ ./
RUN npm run build

# Exportable only for the release context audit; never used as a runtime image.
FROM scratch AS source-audit
COPY . /

# Isolated release scanner: source comes through the same private-file exclusions.
FROM go-base AS vulnerability-check
RUN go install golang.org/x/vuln/cmd/govulncheck@v1.8.0
COPY --from=source-audit / /src/
RUN cd /src/affinity-router && go mod download && cd /src/control-panel/tailnet-gateway && go mod download
ENTRYPOINT ["govulncheck"]

# Static Go services need certificates, time zones and a POSIX entrypoint only.
FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 AS runtime-base
ARG CRAP_REVISION=unknown
LABEL org.opencontainers.image.revision=$CRAP_REVISION \
      org.opencontainers.image.source="https://github.com/darki73/crap" \
      org.opencontainers.image.licenses="MIT"
COPY LICENSE deploy/NOTICE.md /usr/share/doc/crap/
RUN apk upgrade --no-cache && apk add --no-cache ca-certificates tzdata
ENV TZ=UTC
COPY deploy/entrypoint.sh /usr/local/bin/crap-entrypoint
COPY deploy/proxy-storage-guard.sh /usr/local/lib/crap/proxy-storage-guard.sh
RUN chmod 755 /usr/local/bin/crap-entrypoint && mkdir -p /data /CLIProxyAPI/plugins && chown -R 1000:1000 /data /CLIProxyAPI
USER 1000:1000
ENTRYPOINT ["crap-entrypoint"]

FROM runtime-base AS control
COPY --from=affinity-build /out/affinity-control /out/affinity-db /usr/local/bin/
ENV AFFINITY_LISTEN=0.0.0.0:8318 AFFINITY_MAINTENANCE_FILE=/data/maintenance.lock
CMD ["affinity-control"]

FROM runtime-base AS gateway
COPY --from=affinity-build /out/affinity-gateway /usr/local/bin/
ENV AFFINITY_GATEWAY_LISTEN=0.0.0.0:8319
CMD ["affinity-gateway"]

# No Node native addons are loaded. The glibc plugin below is carried as an
# artifact for the official proxy; it is never loaded in this musl-based panel.
FROM node:24-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS panel
ARG CRAP_REVISION=unknown
LABEL org.opencontainers.image.revision=$CRAP_REVISION \
      org.opencontainers.image.source="https://github.com/darki73/crap" \
      org.opencontainers.image.licenses="MIT"
# The runtime uses Node's standard library and prebuilt UI assets, never npm/yarn.
RUN apk upgrade --no-cache && apk add --no-cache ca-certificates tzdata && \
    rm -rf /usr/local/lib/node_modules/npm /opt/yarn-* && \
    rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY LICENSE deploy/NOTICE.md /usr/share/doc/crap/
WORKDIR /app
COPY --from=ui-build /src/dist ./dist
COPY --from=tailnet-build /out/tailnet-gateway /out/lan-gateway /app/
COPY --from=affinity-build /out/affinity-router.so /app/plugin/affinity-router.so
COPY control-panel/*.mjs ./
COPY control-panel/scripts/start.mjs ./scripts/start.mjs
COPY control-panel/client-shell ./client-shell
COPY deploy/*.mjs ./deploy/
COPY deploy/cliproxy-release.json ./deploy/
COPY deploy/proxy-entrypoint.sh deploy/proxy-storage-guard.sh ./deploy/
COPY deploy/entrypoint.sh /usr/local/bin/crap-entrypoint
COPY deploy/proxy-storage-guard.sh /usr/local/lib/crap/proxy-storage-guard.sh
RUN chmod 755 /usr/local/bin/crap-entrypoint && mkdir -p /workspace/.local-panel && chown -R node:node /workspace
ENV NODE_ENV=production PANEL_WORKSPACE_ROOT=/workspace TAILNET_GATEWAY_PATH=/app/tailnet-gateway
USER node
ENTRYPOINT ["crap-entrypoint"]
CMD ["node", "scripts/start.mjs"]
