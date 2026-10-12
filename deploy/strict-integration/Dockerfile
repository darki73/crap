FROM golang:1.27.2-bookworm@sha256:5cf287a799e6b94384bad13d16b14904c531f51ba65792237e122ce42b392f61 AS fixture
WORKDIR /src
COPY deploy/strict-proof/go.mod ./
COPY deploy/strict-proof/fixture ./fixture
RUN mkdir /out && go build -o /out/fixture ./fixture && /out/fixture
FROM node:24-bookworm-slim AS harness
WORKDIR /test
COPY --from=fixture /out/ca.pem /out/key.pem /out/fixture ./
COPY deploy/strict-integration/*.mjs ./
CMD ["node", "provider.mjs"]
