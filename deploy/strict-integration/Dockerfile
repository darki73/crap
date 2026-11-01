FROM golang:1.27.3-bookworm@sha256:d9b6a1beb9474adc2a1ce842573639b44b2a0dd49b6669f51d3821baf9ec37c9 AS fixture
WORKDIR /src
COPY deploy/strict-proof/go.mod ./
COPY deploy/strict-proof/fixture ./fixture
RUN mkdir /out && go build -o /out/fixture ./fixture && /out/fixture
FROM node:24-bookworm-slim AS harness
WORKDIR /test
COPY --from=fixture /out/ca.pem /out/key.pem /out/fixture ./
COPY deploy/strict-integration/*.mjs ./
CMD ["node", "provider.mjs"]
