ALTER TABLE affinity_router.usage_events ADD COLUMN response_ref text;
CREATE INDEX usage_response_ref ON affinity_router.usage_events(response_ref);
CREATE TABLE affinity_router.cache_observations (
 response_ref text PRIMARY KEY CHECK(response_ref LIKE 'v1:%'),
 cache_write bigint NOT NULL CHECK(cache_write >= 0),
 cache_write_5m bigint NOT NULL CHECK(cache_write_5m >= 0),
 cache_write_1h bigint NOT NULL CHECK(cache_write_1h >= 0),
 CHECK(cache_write::numeric = cache_write_5m::numeric + cache_write_1h::numeric)
);
ALTER TABLE affinity_router.price_versions ALTER COLUMN cache_write_rate DROP NOT NULL;
ALTER TABLE affinity_router.price_versions ADD COLUMN cache_write_5m_rate numeric(18,8) CHECK(cache_write_5m_rate >= 0);
ALTER TABLE affinity_router.price_versions ADD COLUMN cache_write_1h_rate numeric(18,8) CHECK(cache_write_1h_rate >= 0);
ALTER TABLE affinity_router.price_versions ADD CONSTRAINT cache_rate_shape CHECK (
 (cache_write_rate IS NOT NULL AND cache_write_5m_rate IS NULL AND cache_write_1h_rate IS NULL) OR
 (cache_write_rate IS NULL AND cache_write_5m_rate IS NOT NULL AND cache_write_1h_rate IS NOT NULL)
);
ALTER TABLE affinity_router.cost_estimates ADD COLUMN pricing_basis text NOT NULL DEFAULT 'legacy_assumed';
CREATE VIEW affinity_router.usage_with_cache AS
 SELECT e.*, o.cache_write_5m, o.cache_write_1h
 FROM affinity_router.usage_events e LEFT JOIN affinity_router.cache_observations o
 ON e.provider='claude' AND e.response_ref=o.response_ref AND e.cache_write=o.cache_write;
