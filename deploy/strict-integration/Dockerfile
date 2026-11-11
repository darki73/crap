FROM golang:1.27.4-bookworm@sha256:4fa7c968ba93f1635670522dbb01a2c78150443e1385746924566079f36570ea AS fixture
WORKDIR /src
COPY deploy/strict-proof/go.mod ./
COPY deploy/strict-proof/fixture ./fixture
RUN mkdir /out && go build -o /out/fixture ./fixture && /out/fixture
FROM node:24-bookworm-slim AS harness
WORKDIR /test
COPY --from=fixture /out/ca.pem /out/key.pem /out/fixture ./
COPY deploy/strict-integration/*.mjs ./
CMD ["node", "provider.mjs"]
