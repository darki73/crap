# Token accounting and pricing

[Documentation index](README.md)

**Token Ledger** records requests observed by CRAP. **Quota & Limits** reports
provider allowance windows. Token counts do not directly convert into subscription
percentages: provider capacity rules and activity outside this proxy also matter.

## Read the categories

| Category                      | Meaning                                                          |
| ----------------------------- | ---------------------------------------------------------------- |
| Uncached input                | Input processed without a reported cache hit or cache write      |
| Output                        | Generated output tokens reported by the provider                 |
| Cache read                    | Tokens served from an existing prompt cache                      |
| Cache write                   | Tokens used to create cache entries                              |
| Five-minute / one-hour writes | Cache writes with a reported duration                            |
| Reasoning                     | Reported reasoning detail; do not blindly add it to output again |
| Unknown                       | The required observation or duration was not supplied            |

A long resumed conversation can send substantial context again on each request.
Reported totals may include cache reads, so a large total does not mean every token
was billed as a fresh prefill. Inspect the categories and actual model. Continuing
through a different account can lose cache reuse; affinity improves the chance of
reuse but does not guarantee a provider cache hit.

**Upstream requests** are individual observed calls, not user messages. A client
can make several calls for one interaction, and client retries are separate calls.
CRAP's strict router does not automatically replay failures.

## Cache duration

The client/native executor's outgoing cache controls and provider behavior determine
cache lifetime. CRAP observes reported five-minute and one-hour creation counts;
it does not let the price catalog choose a request's TTL. When duration is absent,
the ledger keeps it unknown instead of assuming the cheaper five-minute tier.

## Price catalog

Prices are versioned, effective-dated rates per million tokens. Maintain model
identifiers and their separate input, output, cache-read, five-minute-write and
one-hour-write rates in the catalog. Claude's reference is the
[official pricing page](https://platform.claude.com/docs/en/about-claude/pricing).
Consult it when updating rates; these docs do not freeze a current price list.

For known categories, a base estimate is the sum of each category's tokens times
its matching per-million rate, divided by one million. Do not charge cache-read
and cache-write tokens again as uncached input. Unknown categories or missing
prices must remain visible rather than being treated as free. Model aliases need
matching catalog coverage; a display name is not proof of a matching price.

These are **API-equivalent estimates**, not invoices. Subscription payments,
included allowance, extra usage, regional pricing, taxes, promotions and other
provider-specific billing rules can differ. CRAP cannot determine what a provider
charged solely from the price catalog or Claude Code's “API Usage Billing” label.

## Completeness and recovery

Lifecycle and usage observations share an opaque full-trace reference. The ledger
shows delivery coverage, missing observed usage and legacy records that cannot be
linked. A completion without observed usage is flagged after a delivery grace
period; it is not silently assigned zero tokens. Success requires the terminal
stream event, not just HTTP 200.

The durable spool retries delivery idempotently. A crash before the upstream
callback reaches the plugin can still lose observations. CRAP cannot reconstruct
those tokens or promise billing-grade completeness. Preserve the spool and
matching database/keys during [backup and migration](storage.md).
