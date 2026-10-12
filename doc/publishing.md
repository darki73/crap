# Publishing CRAP to GHCR

[Documentation index](README.md)

The selected registry is **GitHub Container Registry**, under `ghcr.io/darki73`.
Nothing is published by a normal push, pull request, tag or candidate build.
The manual [CRAP publish workflow](../.github/workflows/crap-publish.yml) is the
only CRAP publisher and runs only in `darki73/crap`.

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

## When publishing is authorized

1. Commit and push the reviewed source after owner authorization. The workflow
   must be available in GitHub before it can be dispatched. Local configuration
   alone does not run CI or create packages.
2. Open Actions → **CRAP publish to GHCR (manual)** and select the reviewed ref.
   Supply a new version such as `v0.1.0-alpha.1`, then explicitly run the workflow.
3. The reusable candidate workflow runs checks, builds once, scans and packages
   that exact revision. Any failed gate stops publication.
4. The publish job downloads the candidate from the same run, verifies checksums,
   freshness/security-policy evidence, revision labels and all three CRAP image IDs.
   It loads those images rather than rebuilding them.
5. The job logs into GHCR using the repository's `GITHUB_TOKEN`. Only this job has
   `packages: write`. No personal registry token needs to be copied into the code.
6. Existing version or commit tags are refused. Authentication and registry errors
   are not treated as evidence that a tag is free.
7. Save the `crap-ghcr-<commit>` artifact: it contains `published-images.json` and
   `compose.ghcr.json` with exact registry digest references, plus `GHCR-SHA256SUMS`
   to verify both files. Retain the matching
   candidate source, backup helpers and original candidate checksums too.

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
is restricted to the manual GitHub workflow context. Tests use synthetic artifacts
and mocked Docker/registry calls; they do not upload anything. GitHub workflow
execution and actual GHCR permissions remain unverified until the authorized run.
