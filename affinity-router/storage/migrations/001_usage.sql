CREATE TABLE affinity_router.usage_events (
    event_id uuid PRIMARY KEY,
    request_id text NOT NULL CHECK (request_id <> ''),
    replica_id text NOT NULL CHECK (replica_id <> ''),
    account_id text NOT NULL CHECK (account_id <> ''),
    client_id text NOT NULL CHECK (client_id <> ''),
    session_id text,
    provider text NOT NULL CHECK (provider <> ''),
    model text NOT NULL CHECK (model <> ''),
    started_at timestamptz NOT NULL,
    finished_at timestamptz NOT NULL CHECK (finished_at >= started_at),
    outcome text NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'cancelled', 'unknown')),
    quality text NOT NULL CHECK (quality IN ('complete', 'unclassified', 'inconsistent', 'missing')),
    input_uncached bigint CHECK (input_uncached >= 0),
    cache_read bigint CHECK (cache_read >= 0),
    cache_write bigint CHECK (cache_write >= 0),
    output_non_reasoning bigint CHECK (output_non_reasoning >= 0),
    output_reasoning bigint CHECK (output_reasoning >= 0),
    reported_total bigint CHECK (reported_total >= 0),
    received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (quality <> 'complete' OR (
        input_uncached IS NOT NULL AND cache_read IS NOT NULL AND cache_write IS NOT NULL
        AND output_non_reasoning IS NOT NULL AND output_reasoning IS NOT NULL
        AND reported_total IS NOT NULL
        AND reported_total::numeric = input_uncached::numeric + cache_read::numeric + cache_write::numeric
            + output_non_reasoning::numeric + output_reasoning::numeric
    )),
    CHECK (quality <> 'missing' OR (
        input_uncached IS NULL AND cache_read IS NULL AND cache_write IS NULL
        AND output_non_reasoning IS NULL AND output_reasoning IS NULL AND reported_total IS NULL
    ))
);
CREATE INDEX usage_events_account_time ON affinity_router.usage_events (account_id, started_at DESC);
CREATE INDEX usage_events_request ON affinity_router.usage_events (request_id);
