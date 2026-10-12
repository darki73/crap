ALTER TABLE affinity_router.usage_events ADD COLUMN auth_type text NOT NULL DEFAULT 'unknown';
ALTER TABLE affinity_router.usage_events ADD COLUMN service_tier text NOT NULL DEFAULT '';
ALTER TABLE affinity_router.usage_events ADD COLUMN accounting_source text NOT NULL DEFAULT 'unknown';
CREATE TABLE affinity_router.price_versions (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 provider text NOT NULL CHECK(provider <> ''),
 model text NOT NULL CHECK(model <> ''),
 service_tier text NOT NULL DEFAULT '',
 effective_from timestamptz NOT NULL,
 input_rate numeric(18,8) NOT NULL CHECK(input_rate >= 0),
 cache_read_rate numeric(18,8) NOT NULL CHECK(cache_read_rate >= 0),
 cache_write_rate numeric(18,8) NOT NULL CHECK(cache_write_rate >= 0),
 output_rate numeric(18,8) NOT NULL CHECK(output_rate >= 0),
 reasoning_rate numeric(18,8) NOT NULL CHECK(reasoning_rate >= 0),
 note text NOT NULL CHECK(note <> ''),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(provider, model, service_tier, effective_from)
);
CREATE TABLE affinity_router.cost_estimates (
 event_id uuid PRIMARY KEY REFERENCES affinity_router.usage_events(event_id),
 price_id bigint NOT NULL REFERENCES affinity_router.price_versions(id),
 kind text NOT NULL CHECK(kind IN ('api_estimate','api_equivalent')),
 usd numeric(30,12) NOT NULL CHECK(usd >= 0),
 created_at timestamptz NOT NULL DEFAULT now()
);
