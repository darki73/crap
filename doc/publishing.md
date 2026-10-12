# Publishing CRAP to GHCR

[Documentation index](README.md)

The selected registry is **GitHub Container Registry**, under `ghcr.io/darki73`.
Main-branch pushes and pull requests run checks without publishing. Pushing a
version tag starts the [CRAP release workflow](../.github/workflows/crap-publish.yml),
which runs only in `darki73/crap` and publishes only after the complete candidate
checks and scans pass.

## Images and tags

| Image                        | Service                                    |
| ---------------------------- | ------------------------------------------ |
| ghcr.io/darki73/crap-panel   | Dashboard, bridge and bootstrap            |
| ghcr.io/darki73/crap-gateway | Checked inference gateway                  |
| ghcr.io/darki73/crap-control | Routing/accounting control and migrations  |

Each application image receives the requested version (for example
`v0.1.0-alpha.1`) and `sha-<full source commit>`. There is no `latest` tag.
The pinned official PostgreSQL image remains separate; CRAP does not republish it.
Images carry source-repository, revision and MIT-license labels. The candidate
manifest also records the exact official CLIProxyAPI image used for validation.
The default tested reference is in [cliproxy-release.json](../deploy/cliproxy-release.json).

## Publish a reviewed version

1. Commit and push the reviewed source to `main`, then wait for **CRAP checks**.
2. Create a new version tag on that exact commit and push it:

   ```sh
   git tag v0.1.0-alpha.2 REVIEWED_COMMIT
   git push origin v0.1.0-alpha.2
   ```

   The tag must point to a commit reachable from `main`. Branch pushes, foreign
   repositories and mismatched tag/version inputs cannot publish. Tags beginning
   with `v` trigger validation; invalid versions fail before building.
3. The reusable candidate workflow runs all checks, builds once, scans and packages
   the exact tagged revision. CRAP artifact blockers stop publication; external
   proxy/database findings remain informational. See [the security scope](security.md).
4. The publisher downloads the candidate from the same run, verifies checksums,
   policy/freshness evidence, revision labels and all three image IDs, then loads
   those checked images instead of rebuilding them. Only this job has `packages: write`.
5. Registry digests are captured automatically into `published-images.json` and
   `compose.ghcr.json`, covered by `GHCR-SHA256SUMS`. No hand-edited image IDs or
   guessed tags enter the deployment override.
6. A separate job with `contents: write` verifies both sets of checksums and creates
   a draft GitHub release with those deployment files and the full candidate archive.
   It publishes the release only after the asset uploads succeed. Prerelease versions
   are marked as prereleases. `RELEASE-SHA256SUMS` covers the compressed candidate.

The version tag is the deliberate release action. A GitOps repository can use
Renovate to propose a grouped update of both chart refs, all CRAP image digests and
its plugin installer. Keep independently maintained CLIProxyAPI updates separate
for compatibility review. This workflow never commits to GitOps repositories,
merges their updates or syncs Argo applications.

For a failure before any publication, retry the failed workflow jobs. Manual
workflow dispatch is also available, but select the **existing version tag** as
its ref and enter that same version. Dispatching from `main` is rejected. If a
release draft or some image tags already exist, inspect the failure and finish
only the missing stage; never overwrite published images to make a retry pass.

Publication across three repositories is not atomic. A failed run can leave some
tags published. It does not delete or overwrite them on retry. Inspect the partial
result and reconcile it deliberately; do not repoint an existing version silently.
A new version for an already published source commit is also refused by the
commit-tag check. Registry policy and permission failures require operator review.

GHCR package visibility is separate from repository visibility. Review package
access/visibility before announcing a public release. See GitHub's official
[container registry guidance](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
and [Actions publishing guide](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images).

## Deploy published images

After a successful publication, use the retained matching source checkout and
downloaded digest override:

```sh
docker compose -f deploy/compose.yaml -f /path/to/compose.ghcr.json up -d --no-build --wait --wait-timeout 180
```

Pass this same override as --images /path/to/compose.ghcr.json to the backup and
restore commands. For offline recovery, pre-pull every recorded digest and change
only pull_policy to never. Keep the override with the workspace's recovery material. The PostgreSQL image is
still pinned by the base composition. Follow [operations](../deploy/OPERATIONS.md)
for backup/restore with matching images; never substitute an unrelated checkout.

## Local verification without publishing

```sh
node --test deploy/publish-ghcr.test.mjs
node deploy/publish-ghcr.mjs /path/to/candidate v0.1.0-alpha.1
```

The second command validates a real candidate and prints its plan. It neither
loads images nor queries the registry. Real publication requires `--publish` and
is restricted to a matching version-tag GitHub workflow context. Tests use synthetic artifacts
and mocked Docker/registry calls; they do not upload anything. The initial
[v0.1.0-alpha.1 publication run](https://github.com/darki73/crap/actions/runs/38239638442)
verified the workflow and GHCR permissions. All three images were checked through
anonymous registry access against the candidate image identities.

The [prerelease](https://github.com/darki73/crap/releases/tag/v0.1.0-alpha.1)
retains deployment files, their checksums and the full CRAP candidate archive.
Actions artifacts expire; retain these release assets for installation and recovery.
