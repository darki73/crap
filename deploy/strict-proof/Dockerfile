# Built only for the disposable compatibility proof, never a release image.
FROM eceasy/cli-proxy-api:v8.0.24@sha256:302807246399682928f6dcf5a6f52032024ebffaf0e9c8bdeb05a7e235028d6f AS core
FROM golang:1.27.2-bookworm@sha256:5cf287a799e6b94384bad13d16b14904c531f51ba65792237e122ce42b392f61 AS proof
WORKDIR /src
COPY deploy/strict-proof/go.mod ./
COPY deploy/strict-proof/plugin ./plugin
COPY deploy/strict-proof/fixture ./fixture
RUN CGO_ENABLED=1 go build -buildmode=c-shared -o /out/strict-proof.so ./plugin && \
    CGO_ENABLED=0 go build -o /out/fixture ./fixture && /out/fixture

FROM debian:bookworm-slim@sha256:0104b334637a5f19aa9c983a91b54c89887c0984081f2068983107a6f6c21eeb AS proxy
WORKDIR /proof
COPY --from=core /CLIProxyAPI/CLIProxyAPI /proof/proxy
COPY --from=proof /out/strict-proof.so /proof/plugins/strict-proof.so
COPY --from=proof /out/fixture /proof/fixture
COPY --from=proof /out/ca.pem /proof/ca.pem
COPY deploy/strict-proof/config.fixture.yaml /proof/template.yaml
RUN mkdir /state && chown 1000:1000 /state
ENV SSL_CERT_FILE=/proof/ca.pem
USER 1000:1000
# Upstream rewrites the management key to a hash; do that only in tmpfs.
ENTRYPOINT ["sh", "-c", "cp /proof/template.yaml /state/config.yaml && exec /proof/proxy --config /state/config.yaml --local-model"]

FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS harness
WORKDIR /proof
COPY --from=proof --chown=node:node /out/ca.pem /out/key.pem /proof/
COPY deploy/strict-proof/*.mjs /proof/
USER node
CMD ["node", "boundary.mjs"]
