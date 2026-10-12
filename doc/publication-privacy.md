# Publication privacy

Public files should contain product source, synthetic tests, deployment templates
and user-facing documentation. Keep conversations, internal decisions, review
records and operator information in the ignored `design/` directory or outside
the repository. Live configuration and credentials belong in private storage.

## Before publishing

Run from the repository root:

```sh
node --test deploy/scan-privacy.test.mjs
node deploy/scan-privacy.mjs
node deploy/scan-secrets.mjs
node deploy/check-build-context.mjs
```

Review the staged file list and diff yourself. Pattern checks cannot determine
whether prose describes a private conversation. Public Markdown files must also
be listed in `deploy/privacy-policy.json`; add a document only after reviewing
its contents for publication. Private `design/` files are rejected even if
force-added. Docker contexts exclude that directory too.

The privacy scan checks Git-visible files for private paths, attachments,
non-example addresses, infrastructure names and literal identifiers. Findings
are written under ignored `.local-panel`; terminal output contains counts rather
than source values. The separate credential scan covers source and Git history.
Neither scanner changes Git identity or publishes source.

Exact fixture exceptions in [the privacy policy](../deploy/privacy-policy.json)
are tied to file, finding kind and content fingerprint. Do not regenerate them
automatically to make a failed scan pass. Unknown prose, encoded data and image
metadata still require manual review.

## History matters

Ignoring or deleting a tracked file does not remove it from earlier commits.
Recreating a remote repository and pushing the same history republishes those
files. After an accidental publication, use a separately reviewed clean source
snapshot with fresh history, or explicitly review a history-rewriting procedure.
Keep private backups outside the new publication tree. Removing a repository
cannot retract copies already obtained by others.

## Private data and artifacts

Never commit credentials, OAuth callbacks, generated installers, database dumps,
kubeconfigs, migration handoffs or exported logs. Use `.local-panel` or another
private location. Do not force-add ignored files. Use reserved example domains
and synthetic identities in fixtures.

The [privacy workflow](../.github/workflows/crap-privacy.yml) runs after a push;
it cannot prevent the initial disclosure. Candidate packaging reruns the checks,
but release archives include committed files, so review those inputs first.
Review Git author identity separately: it becomes public commit metadata.
