# Preparing a release candidate

The **CRAP release candidate (no publishing)** workflow is manually dispatched
against a committed source revision. It calls the full CRAP checks workflow first.
Only after those jobs pass does it build the three CRAP Linux amd64 application images,
scan those images, the official external proxy image/binary, PostgreSQL, CRAP Go
source and the npm lockfile, and
create a short-lived GitHub Actions artifact. It does not push images, create
a GitHub release, send notifications or need registry credentials.

The artifact contains image and committed-source tar archives, exact source and
image identities in `manifest.json`, a matching image override, license/notice
files, a CycloneDX dashboard dependency inventory, Go module inventories and
the vulnerability scan evidence. CRAP artifact findings and external proxy/database
findings also have separate reports; classification does not change the overall gate.
`SHA256SUMS` covers all other files. Checksums detect corruption; they are not
signatures and do not establish trust in an untrusted download.

After verifying the checksums and reviewing the source, load `images.tar` with
`docker load -i images.tar`. Extract `source.tar` into a fresh directory. From
that source directory, use the strict composition and downloaded image override:

```sh
docker compose -f deploy/compose.yaml -f /path/to/compose.images.json up -d --no-build --wait --wait-timeout 180
```

Keep the artifact, override, source and backup together for a tested upgrade.
Pass `--images /path/to/compose.images.json` to both backup and restore commands
so the helpers and restored services use those same retained images. The override
is validated as image-only; it cannot replace networks, commands or credentials.
Do not use mutable `alpha-local` tags to identify rollback versions. The initial
candidate is a baseline; real old/new release-pair upgrade rehearsals remain a
gate when both versions exist. The included PostgreSQL image stays digest-pinned
in the composition. Bootstrap refuses incompatible pre-strict configuration.

The single source repository is [darki73/crap](https://github.com/darki73/crap).
Images are configured for GHCR under ghcr.io/darki73. The separate manual
[publisher](../doc/publishing.md) calls this reusable candidate workflow and uploads
only its verified images. This candidate workflow itself still never publishes.
[GitHub private security reporting](https://github.com/darki73/crap/security/advisories/new)
is enabled. Inherited CLIProxyAPI build/publication workflows have been removed.

Dependency inventories describe contents, not vulnerability clearance. The
candidate gate rejects unresolved high/critical image findings (including unfixed ones)
and reachable Go advisories. Missing/failed scans cannot pass. Packaging requires
a passing report less than 24 hours old and matching image IDs/references.
Run `node deploy/scan-vulnerabilities.mjs` locally after building, then
`node deploy/report-scan-ownership.mjs` for the ownership summaries. Reports are
under `.local-panel/security-review/` and retained as a CI artifact even on failure.
Review the scan artifacts for the exact candidate revision. The
[security guide](../doc/security.md) describes the enforced gate. Multi-architecture
publishing is unsupported. No published registry is implied by local image names.

The gate has narrowly scoped binary-package applicability exceptions in
`vulnerability-exceptions.json`. Each names the exact advisory, package version,
Debian version, image role, reason, primary reference and review expiry. A
networkless, read-only inspection of the exact image ID must confirm that the
vulnerable component is absent. Original findings remain in the reports;
`applicability.json` records every accepted exception and its evidence. Unknown,
changed or expired cases remain blockers. There is no severity-wide ignore list.

Packaging also compares the current security/deployment input hash with the scan
and rejects expired exception evidence, even if the scan is less than 24 hours old.
Any policy, entrypoint, probe, Dockerfile, Compose or scanner change requires a
fresh scan. Separate ownership reports do not exempt external dependencies from
the executable release gate.
