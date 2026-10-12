# Routing and quota

[Documentation index](README.md)

Strict routing prioritizes conversation continuity and fewer cache rebuilds. It
uses personally owned Claude subscriptions, not the engine's round-robin selector.
The mandatory plugin and isolated network enforce selection outside upstream core.

## Selection order

1. Exclude disabled, invalid, model-ineligible or otherwise unusable accounts.
2. Check each applicable quota window against the saved reserve.
3. Keep an eligible conversation-family binding, including parent/subagents.
4. Otherwise keep filling the currently selected eligible account.
5. When a new choice is required, prefer known eligible quota, then the lowest
   remaining applicable weekly allowance, then five-hour allowance, then stable ID.
6. If only unknown candidates remain, allow a real request to learn their limits.
   If none is usable, return an error immediately rather than queueing or replaying.

A new family does not spread work merely to equalize usage. An existing binding
outranks the least-remaining order. Binding does not expire just because a session
is idle. Explicit session/parent identifiers support resumes and inheritance;
there is no similarity matching against prompt text.

## The reserve applies to every request

Set **Quota reserve (%)** in **Routing & Affinity**. A 5% minimum means:

| Five-hour remaining | Weekly remaining | Eligible by these windows? |
| ------------------- | ---------------- | -------------------------- |
| 100%                | 3%               | No                         |
| 3%                  | 100%             | No                         |
| 40%                 | 5%               | Yes                        |
| 40%                 | 60%              | Yes                        |

Applicable model windows are checked independently too. Values are not averaged.
Exactly 5% meets a 5% minimum; a rejected/exhausted window still blocks with a zero
reserve. A model-specific window for another model does not constrain this one.

The rule applies to new conversations, resumed families and subagents. Falling
below reserve moves the family before its next request. An already running
response is not moved or replayed. Recovery of the old account does not pull the
family back. Stale data, external account use and unknown request size mean the
reserve cannot guarantee a long generation will finish.

## How quota is learned

CRAP consumes quota information exposed by normal provider responses when available.
Missing response headers do not erase previous observations. Background provider
lookups have a shared per-account/provider admission interval of at least five
minutes; Retry-After/backoff can extend it. It is not one global call per five
minutes regardless of account count.

The quota page reads cached server observations every 15 seconds while visible.
That UI refresh is not a provider lookup. Age and refresh failures remain visible;
strict routing does not discard an otherwise usable account solely because an
observation is old. At a known reset, a real request can learn the new window;
CRAP does not manufacture a fresh 100% reading.

## Errors and retries

Temporary overload does not cause account churn. CRAP makes one upstream attempt
per admitted request and returns its error. The Claude client may independently
retry. Authentication, model incompatibility and quota information learned from a
failure affect subsequent requests; CRAP does not replay the failed generation.

With no usable account, the gateway returns `429 crap_no_usable_account` and reset
information when known. Dependency/plugin failures return readiness errors.
See [troubleshooting](troubleshooting.md) and the
[strict routing implementation](../deploy/STRICT-ROUTING.md).
