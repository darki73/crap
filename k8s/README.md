# Kubernetes deployment recipes

Choose **Helm**, **Argo CD**, or **plain manifests**. They describe the same single-owner,
single-replica topology. CNPG/PostgreSQL is supplied by you; these recipes never create,
replace or take ownership of your database cluster.

These are deployment recipes validated by rendering, schema and offline topology checks.
They have **not** been exercised against your Kubernetes cluster. The first cluster rehearsal
must verify your CNI, StorageClass, CNPG certificates, restore procedure and stream behavior
before moving live accounts. Multi-replica operation and zero-downtime upgrades are not supported.

| Path | Use |
| --- | --- |
| [helm/crap](helm/crap/Chart.yaml) | CRAP panel, gateway, control, migrations, PVCs and policies |
| [helm/cliproxy](helm/cliproxy/Chart.yaml) | Separately installed official proxy, CRAP plugin, PVC and isolation policy |
| [argocd/application.yaml](argocd/application.yaml) | One Application with two independently configured chart sources |
| [manifests](manifests/namespace.yaml) | Checked-in rendered YAML; Helm is unnecessary to apply it |
| [prepare-secrets.mjs](prepare-secrets.mjs) | Offline PostgreSQL provisioning and Kubernetes Secret preparation |
| [examples/private-ingress.yaml](examples/private-ingress.yaml) | Optional private owner-access ingress; requires site-specific configuration |

## Topology and prerequisites

Clients connect to the **api** Service (CRAP gateway, port 8319), never directly to the
**proxy** Service. The dashboard uses **panel:3000**. Internal **gateway:8320/8321** listeners
handle execution grants and provider egress; **control:8318** owns routing and accounting.
The proxy can reach only the control service, gateway, selected database pods and DNS.
Only the gateway and panel have public HTTPS egress. No NodePort, LoadBalancer or Ingress
is created by default. The gateway fails closed if the required plugin/control is unavailable.

You need:

- Kubernetes 1.30+ API support and Linux amd64 nodes. Use a Kubernetes version still
  supported by your distributor; the minimum API version is not a maintenance recommendation.
- A CNI that actually enforces ingress **and egress** NetworkPolicy, such as a correctly
  configured Cilium or Calico installation. YAML acceptance alone does not prove enforcement.
  Keep the dedicated namespace free of other policies that broadly allow proxy egress:
  Kubernetes policies are additive. No host-networked workloads.
- A working default StorageClass or an explicit class in both charts. Three ReadWriteOnce
  PVCs retain panel/Tailscale state, control maintenance state, and proxy cache/plugin spool.
  The runtime user/group is 1000; the CSI driver must honor fsGroup or volumes must be
  provisioned with matching ownership. There are no root permission-fixing init containers.
- A dedicated PostgreSQL 17 database in your existing CNPG cluster, its public CA certificate,
  and an administrator mechanism to provision application roles. Use the **-rw** service
  directly, not transaction-pooling PgBouncer, for schema migrations and the initial deployment.
- Reviewed CRAP images available to your cluster. The checked-in REPLACE_WITH_RELEASE tags
  are deliberate placeholders. Download published-images.json from the
  [alpha release](https://github.com/darki73/crap/releases/tag/v0.1.0-alpha.1) and pin panel,
  gateway and control to its matching release digests. The proxy chart's pluginImage must
  equal CRAP's panel image. Private registries need imagePullSecrets in both charts.
- kubectl. Helm users also need Helm 3.19+ or 4; Argo CD users need a version supporting
  multiple sources and Helm valuesObject. Node 24 is needed only for offline secret preparation.

Service names are intentionally fixed to match the existing CRAP environment/configuration
contract. Install one workspace per namespace. The default namespace is **crap**; if changed,
update the namespace manifest, commands, Secret preparation and Argo destination together.

## Prepare PostgreSQL and secrets

Run commands from the repository root. The checked-in examples contain no credentials.
Keep all generated private files under the ignored .local-panel directory or a private folder
outside the repository. Kubernetes Secret data is base64, **not encryption**; apply your normal
cluster Secret encryption/RBAC controls or deliver the equivalent keys through your secret manager.

1. Export the CNPG cluster's **public CA only** to .local-panel/cnpg-ca.crt using your normal
   administrator workflow. Do not export its private key. Copy [database.json](examples/database.json)
   to .local-panel/k8s-database.json and set host, port, database and caFile. Paths are resolved
   from your current working directory. The host must match the server certificate and resolve
   from the pods (for example postgres-rw.database.svc.cluster.local).
2. Prepare a fresh destination directory:

   ~~~sh
   node k8s/prepare-secrets.mjs .local-panel/k8s-database.json .local-panel/k8s-prepared crap
   ~~~

   Nothing connects to PostgreSQL or Kubernetes. The command creates separate migration,
   runtime and proxy roles/passwords, matching management/control/identity keys, a strict proxy
   configuration, provision.sql, secrets.json and an identity backup. Existing output is refused.
   A failed command leaves partial private files for inspection; do not apply them.
3. Create the empty database through your CNPG administration workflow. Review and apply
   provision.sql against **that database**, from a host or administrator pod with verified TLS:

   ~~~sh
   psql "service=crap-admin" -X -v ON_ERROR_STOP=1 --file=.local-panel/k8s-prepared/provision.sql
   ~~~

   Configure the libpq service/password file privately. This is an operator command, not a
   dashboard task. No administrator credential is mounted into CRAP. The runtime role cannot
   perform migrations; its migration-table access is restricted by the migration init container.
   CLIProxyAPI keeps the schema CREATE privileges its unchanged startup requires.
4. Create the dedicated namespace:

   ~~~sh
   kubectl apply -f k8s/manifests/namespace.yaml
   ~~~

5. Select the installation path below. On a **first install**, create the workloads/policies
   before applying secrets.json; missing Secret volumes keep containers from starting while
   the policies are installed. Verify policy enforcement before loading live account credentials.
   These manifests do not grant permissions in the database namespace: if CNPG ingress is
   restricted, its operator must allow this namespace's control/proxy pods on the database port.

The four Secret names default to crap-control, crap-migrate, crap-panel and crap-proxy.
Each contains service.env; all except panel also contain ca.crt; proxy also contains
config.example.yaml. They are consumed as files, not envFrom. The preparation tool uses
verified TLS with sslrootcert=/run/crap/ca.crt and prepares both CRAP and CLIProxyAPI.
The panel/gateway receive no PostgreSQL administrator or runtime database password.

## Option A: Helm

Copy the two values files into private operator files (for example .local-panel/crap-values.yaml
and .local-panel/cliproxy-values.yaml). Edit images, persistence, and the **same** network.databaseNamespace,
network.databasePodLabels, databasePort and DNS settings in both. The CNPG cluster label normally
is cnpg.io/cluster; verify your actual pod labels. NodeLocal DNS users must supply their resolver
CIDR in network.dnsCIDRs in both charts. DNS rules permit only TCP/UDP 53.

~~~sh
helm lint k8s/helm/crap --strict -f .local-panel/crap-values.yaml
helm lint k8s/helm/cliproxy --strict -f .local-panel/cliproxy-values.yaml
helm upgrade --install cliproxy k8s/helm/cliproxy -n crap -f .local-panel/cliproxy-values.yaml
helm upgrade --install crap k8s/helm/crap -n crap -f .local-panel/crap-values.yaml
kubectl apply -f .local-panel/k8s-prepared/secrets.json
kubectl -n crap rollout status deployment/control --timeout=300s
kubectl -n crap rollout status deployment/proxy --timeout=300s
kubectl -n crap rollout status deployment/gateway --timeout=300s
kubectl -n crap rollout status deployment/panel --timeout=300s
~~~

Do not add --wait to the **first** chart installation: the two charts depend on each other
and readiness is expected to wait for the other services/secrets. Subsequent upgrades can
wait after both releases are configured. The control Deployment runs affinity-db as an init
container before starting its runtime; the migration Secret is not mounted in the runtime
container. PostgreSQL advisory locking serializes migrations. No Helm migration hook or
Argo PreSync job races Secret creation.

The separate cliproxy chart pulls the official upstream image. Its init container copies
only CRAP's shared-library plugin and startup adapter from the matching panel image into
an ephemeral volume; no upstream source is downloaded, compiled or modified. The upstream
image version is independent of the CRAP image versions. Use the tested default pin until
a newer official plugin-enabled release has passed your compatibility rehearsal.

## Option B: Argo CD

Prepare the database and namespace first. Copy [application.yaml](argocd/application.yaml) into
your GitOps repository. Set repoURL if you use a fork, set **both** targetRevision fields to
the same reviewed Git commit/tag, and configure image digests, storage and database/DNS
selectors in each source's valuesObject. Both sources resolve charts from this repository;
there is no assumed public Helm registry. CRAP's repository/chart revision must be pushed
before Argo can fetch it. Nothing in this recipe publishes that revision for you.

~~~sh
kubectl apply -f path/to/your/crap-application.yaml
~~~

Sync manually in Argo CD. Network policies use sync wave -2 and workloads use the normal
wave. On the first sync, workloads wait for the pre-existing Secret names; once policies
are present, deliver secrets.json or let your secret manager create those Secrets. Then
wait for the four Deployments to become healthy. Do not place plaintext or base64 Secret
data in the Application or Git values. CRAP is deployed by Argo's Helm rendering; do not
also manage these same objects with helm install.

Automated sync and pruning are deliberately absent from the starter Application. Once a
rehearsal passes, you may enable automated sync against a reviewed Git revision/update
process. That synchronizes Git changes; it does not discover daily upstream releases.
Keep image updates digest-pinned and tested. PVCs have Prune=false,Delete=false annotations;
retain the separately supplied CNPG cluster, Secrets and backups. No cascading deletion
finalizer is supplied in this example.

## Option C: plain manifests

Copy [crap.yaml](manifests/crap.yaml) and [cliproxy.yaml](manifests/cliproxy.yaml) to your deployment
directory. Replace image placeholders, namespace, StorageClass/sizes, database and DNS
selectors, panel origins/API origin, and the proxy plugin image. Update every repeated
selector occurrence consistently. Existing PVCs can be used by changing claimName and
omitting the matching PVC resources from your copy. There is no Helm dependency at runtime.

~~~sh
kubectl apply -f path/to/your/crap.yaml -f path/to/your/cliproxy.yaml
kubectl apply -f .local-panel/k8s-prepared/secrets.json
kubectl -n crap rollout status deployment/control --timeout=300s
kubectl -n crap rollout status deployment/proxy --timeout=300s
kubectl -n crap rollout status deployment/gateway --timeout=300s
kubectl -n crap rollout status deployment/panel --timeout=300s
~~~

The checked-in YAML is generated with node k8s/render.mjs from the default charts.
CI checks it for drift. Customize your own copies; regenerate the defaults only when
changing the charts. To remove a plain deployment, delete its Deployments/Services and
policies explicitly. **kubectl delete -f on the whole files would also delete PVCs**:
Helm/Argo retention annotations do not prevent a direct kubectl delete.

## Access and first checks

Start with loopback port-forwards in separate terminals:

~~~sh
kubectl -n crap port-forward service/panel 3000:3000 --address=127.0.0.1
kubectl -n crap port-forward service/api 8319:8319 --address=127.0.0.1
~~~

Open http://localhost:3000. Configure Claude Code to use the CRAP API origin
http://localhost:8319 (the dashboard's client installer provides the matching key).
Check http://localhost:8319/readyz: success requires the active plugin and control service,
not just an open proxy TCP port. The internal gateway Service publishes not-ready addresses
so execution callbacks can bootstrap; the client-facing api Service publishes only ready pods.

For remote access, configure CRAP's existing userspace Tailscale integration from the dashboard.
It retains state on panel-data and requires no privileged sidecar or /dev/net/tun. The default
policy allows public HTTPS relay traffic; direct UDP peer paths are intentionally not enabled.
Alternatively adapt the optional private-ingress example and configure owner authentication
at your ingress. Host/Origin validation is **not** authentication. Set panel.origins to include
the exact dashboard origin and panel.apiOrigin to the externally reachable API origin; configure
TLS, request size, streaming buffering/timeouts and your ingress namespace/pod labels. Do not
expose proxy, control, or the internal gateway listener through any ingress.

Before adding live accounts, use disposable credentials and your cluster's network-test tools
to confirm: proxy cannot reach a provider by hostname **or public IP**; unrelated pods cannot
reach proxy/control/internal gateway; panel and gateway can reach required services; stopping
the plugin/control causes /readyz and client requests to fail closed. Verify DNS and CNPG TLS
from both control and proxy. Offline topology tests cannot prove CNI enforcement.

## Move the existing workspace and operate it

For your existing local accounts, **do not use the new-workspace flow to generate replacement
identity keys**. Follow [storage migration](../doc/storage.md) and the
[verified PostgreSQL import procedure](../deploy/EXTERNAL-DATABASE.md) first: pause the source,
export/restore both schemas, retain the import handoff and matching identity/management keys.
Add importDirectory (the restored handoff folder) to the preparation JSON. The same
prepare-secrets command then reuses those keys and produces import provisioning SQL.
Do not run the fresh-database SQL on an occupied target.

The Kubernetes manifests do not upload or restore backups. The native PostgreSQL restore
helper can run from an administrator environment with connectivity. Copy/recover required
panel and proxy local state according to the backup runbook; PostgreSQL backup alone does
not preserve every local state file. Restored integration activation remains guarded by the
existing import handoff. Never run source and destination against live accounts simultaneously.

Check the **persisted** proxy config in PostgreSQL after a restore: config.example.yaml only
seeds an empty store. An old config must use this namespace's gateway egress, enabled native
plugin and zero native retries before traffic is enabled. Restored TCP readiness alone is
not proof of a valid strict routing deployment.

Keep one replica per component. Recreate updates intentionally allow downtime and avoid
concurrent Telegram/Tailscale workers, native refresh owners and gateway grant state.
Drain/stop new client traffic before an update and allow active streams to finish; the
120-second termination grace is a bound, not a guarantee that a long stream will finish.
Back up both PostgreSQL schemas, all three PVCs and matching Secrets before migrations.
A Helm rollback does not roll back PostgreSQL migrations: restore a matching database/state
backup into an isolated target if the previous release cannot read the new schema.

Secret updates require controlled pod restarts (the proxy adapter copies its Secret during
initialization). Restart the appropriate workloads after a coordinated key/CA rotation; do
not regenerate keys as a troubleshooting step. CNPG CA renewal is a rotation operation too.
The existing Compose lifecycle/whole-workspace backup commands do not manage Kubernetes;
use CNPG backups and CSI snapshots/file backups with a coordinated maintenance window.

## Validate recipe changes

~~~sh
helm lint k8s/helm/crap --strict
helm lint k8s/helm/cliproxy --strict
node k8s/render.mjs --check
python -m pip install PyYAML==6.0.3
python k8s/check.py
node --test k8s/prepare-secrets.test.mjs
go run github.com/yannh/kubeconform/cmd/kubeconform@v0.7.0 -strict -summary -kubernetes-version 1.30.0 k8s/manifests/ k8s/examples/private-ingress.yaml
~~~

These commands never access kubeconfig or apply cluster resources. Schema validation fetches
public Kubernetes schemas. Cluster validation is a separate operator rehearsal.

References: [Kubernetes NetworkPolicy](https://kubernetes.io/docs/concepts/services-networking/network-policies/),
[Argo CD multiple sources](https://argo-cd.readthedocs.io/en/stable/user-guide/multiple_sources/),
[Argo CD sync waves](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-waves/),
[CNPG application connections](https://cloudnative-pg.io/docs/devel/applications/).


## Optional LAN access with mutual TLS

The [LAN entrypoint recipe](examples/lan-mtls.yaml) is an optional CRAP-owned
listener for clusters where cross-node source NAT prevents a NetworkPolicy from
recognizing ingress-controller pods. It requires CRAP alpha.5 or later, existing
Traefik CRDs with `ServersTransport.rootCAs`, and existing cert-manager. It does not
install or reconfigure those controllers, Cilium, DNS or any shared issuer.

Customize a private copy: the public HTTPS origin (also add it to `panel.origins`),
exact published panel image digest, LAN allowlist, ingress-controller selectors,
DNS selectors and every ingress worker's individual IP. Keep all CRAP services on
the same selected node; the entrypoint's required pod affinity keeps its internal
HTTP hop on that node. This is single-node placement, not cross-node HA.

Traffic follows `Traefik -> mTLS :9443 -> panel :3000 or strict API :8319`.
The listener is shipped in the panel image as `/app/lan-gateway`, runs without
panel credentials or a Kubernetes API token, validates a dedicated client URI,
and only admits the documented inference paths. Client API keys remain mandatory.
Only the mTLS port admits worker addresses. Remove any previous policy granting
Traefik or workers direct access to panel/API ports; NetworkPolicies are additive.
The panel is administered by every device allowed through the LAN middleware;
this recipe does not add a dashboard login. Do not remove the allowlist.

Internal certificates are created locally by namespaced SelfSigned/CA issuers;
there is no ACME request, DNS challenge or use of a public issuer. Browser-facing
HTTPS continues using the existing Traefik certificate. The one-day server and
client certificates renew eight hours before expiry, with new leaf keys. Projected
Secrets and Traefik's Secret watcher reload them without restarting CRAP. Do not
use subPath Secret mounts. Invalid or expired credentials fail closed. Existing
streams are not deliberately interrupted by routine renewal.

The ten-year CA certificate renews with its existing key one year before expiry.
Back up its Secret securely with the workspace and monitor Certificate readiness
and expiration. Replacing a CA **key** or recovering after loss is a coordinated
maintenance operation: issue both new leaves and update both trust bundles before
resuming traffic. Automatic leaf renewal is not automatic recovery from CA loss.
The LAN container never mounts the CA signing key or Traefik's client key.

Validate a private render before committing. After your GitOps controller deploys
it, check the three Certificates and two Issuers are Ready, then test the HTTPS
dashboard and an unauthenticated POST to `/v1/messages` (401, no inference).
Access without a valid client certificate on internal port 9443 must fail its TLS
handshake. Confirm a real stream separately; ingress-controller global timeouts
still apply, and a single-replica rollout can interrupt active connections.

References: [cert-manager private CA](https://cert-manager.io/docs/configuration/ca/)
and [Traefik backend mutual TLS](https://doc.traefik.io/traefik/reference/routing-configuration/kubernetes/crd/http/serverstransport/).
