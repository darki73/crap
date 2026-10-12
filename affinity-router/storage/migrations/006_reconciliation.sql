ALTER TABLE affinity_router.usage_events ADD COLUMN trace_ref text;
ALTER TABLE affinity_router.request_journal ADD COLUMN trace_ref text;
CREATE INDEX usage_events_trace ON affinity_router.usage_events(trace_ref) WHERE trace_ref IS NOT NULL;
CREATE INDEX request_journal_trace ON affinity_router.request_journal(trace_ref) WHERE trace_ref IS NOT NULL;
