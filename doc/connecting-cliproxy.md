# Connect CLIProxyAPI

[Documentation index](README.md)

CLIProxyAPI is maintained and released separately by
[Router-For.ME](https://github.com/router-for-me/CLIProxyAPI). CRAP does not contain,
build, patch or republish its engine. Install a plugin-enabled official distribution;
no-plugin releases cannot run the mandatory CRAP plugin.

## Guided Docker installation

The default [composition](../deploy/compose.yaml) pulls the official
`eceasy/cli-proxy-api` image directly from its publisher. The tested version and
immutable digest are recorded in [cliproxy-release.json](../deploy/cliproxy-release.json).
Only the panel, gateway and control images are built by CRAP. The panel image carries
CRAP's own native plugin, which bootstrap installs into the proxy's mounted plugin
folder. A mounted startup adapter loads generated settings; it never changes the
upstream binary or image.

Follow [Getting started](getting-started.md). Both services receive separate
PostgreSQL roles. The official proxy stays on the internal network with no host
port; clients use CRAP's gateway. Installation and compatibility checks send no
model requests. Normal real usage starts only when you send a request.

## Connect an existing installation

Your existing installation must support native plugins and the required execution
hooks. CRAP checks actual plugin/control readiness before admitting inference;
management API connectivity alone is not sufficient. The currently exercised
baseline is v8.0.24 on Linux amd64. Arbitrary versions/platforms are not certified.

For an independently managed Docker installation:

1. Create an internal Docker network, for example
   `docker network create --internal crap-existing-private`. Place the proxy on
   this network only, with no published host port or alternate outbound network.
   CRAP's gateway supplies the checked outbound path. The database, control and
   gateway join the same network through the overlay below.
2. Set `CRAP_PROXY_NETWORK` to that network name and `CLI_PROXY_URL` to the
   proxy's private network alias and port, such as `http://my-proxy:8317`.
3. Create a private shell-format environment file containing
   `MANAGEMENT_KEY='your-existing-management-key'`. Set
   `CRAP_PROXY_CONNECTION_FILE` to its absolute path. It is mounted only into
   CRAP's panel and gateway, never embedded in an image or copied into the browser.
4. Start CRAP with the two files below. This starts CRAP and its database, **not**
   your proxy. Extract CRAP's plugin and generated integration settings with
   `docker compose -f deploy/compose.yaml cp bootstrap:/bootstrap/proxy ./private-proxy-setup`.
   Keep that directory private: it includes integration credentials.
5. Install `affinity-router.so` into the existing proxy's plugin directory. Merge
   the generated plugin and routing settings into its configuration while preserving
   your accounts and management key. Supply the matching `AFFINITY_CONTROL_URL`,
   `AFFINITY_CONTROL_TOKEN` and `AFFINITY_ID_KEY` from the generated service.env;
   set `CRAP_STRICT_URL=http://gateway:8320` and a writable `AFFINITY_SPOOL`.
   Keep native retries disabled and the required plugin enabled as shown in the
   generated config. Preserve your existing storage configuration and credentials.
6. Restart your proxy yourself. Refresh the dashboard and check readiness before
   configuring a client. A missing/disabled/incompatible plugin returns an error;
   CRAP never silently enables unchecked routing.

`CLI_PROXY_URL`, `CRAP_PROXY_NETWORK` and `CRAP_PROXY_CONNECTION_FILE` must be set
in the invoking environment (or a private Compose env file).

```sh
docker compose -f deploy/compose.yaml -f deploy/compose.existing.yaml up -d --build
```

This mode requires operator-managed isolation and installation. The standard
full-workspace backup command deliberately refuses a missing Compose-managed
proxy; it cannot promise to back up a separately owned database/auth directory.
Back up and restore that proxy with its own tooling and coordinate it with CRAP's
state. Use the guided topology for the automated whole-workspace recovery flow.

## Independent updates

Choose an explicit official version/digest. For the guided topology, set
`CLI_PROXY_IMAGE` to that official reference and run a disposable compatibility
rehearsal before replacing your real proxy. No CRAP release or rebuilt proxy image
is needed. Keep the previous image and take a backup before an actual upgrade.
The existing-installation mode never manages the upstream lifecycle.

```sh
node deploy/strict-integration/run.mjs
```

The fixture uses the same environment override, checks plugin admission, exact
account selection, reserve handling, streaming and encrypted recovery, and cleans
up its own containers. It uses synthetic accounts and a mock provider. A successful
fixture does not certify every upstream feature or every future release.

## Release ownership

CRAP publishes only `crap-panel`, `crap-gateway` and `crap-control`. Its archives
contain CRAP source and images, plus a reference to the external proxy. They contain
no CLIProxyAPI source or engine binary. Current deployment scans still inspect the
official proxy image/binary as an external dependency and retain its findings; its
source is no longer compiled or source-scanned by CRAP. No upstream finding is
silently waived by this packaging change.
