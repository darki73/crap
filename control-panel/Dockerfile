# Export-only stage for the private-file context check. Never a runtime image.
FROM scratch AS source-audit
COPY . /

FROM golang:1.27.1-bookworm AS tailnet-build
WORKDIR /src
COPY tailnet-gateway/ ./
RUN CGO_ENABLED=0 go build -o /tailnet-gateway . && CGO_ENABLED=0 go build -o /lan-gateway ./cmd/lan-gateway

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=tailnet-build /tailnet-gateway /lan-gateway ./
COPY *.mjs ./
COPY scripts/start.mjs ./scripts/start.mjs
COPY client-shell ./client-shell
RUN mkdir -p /workspace/.local-panel && chown -R node:node /workspace
ENV PANEL_WORKSPACE_ROOT=/workspace
ENV TAILNET_GATEWAY_PATH=/app/tailnet-gateway
VOLUME /workspace
USER node
EXPOSE 3000
CMD ["node", "scripts/start.mjs"]
