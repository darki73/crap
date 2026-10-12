CREATE TABLE affinity_router.quota_snapshots (
 account_id text PRIMARY KEY,
 provider text NOT NULL,
 plan text NOT NULL DEFAULT '',
 observed_at timestamptz NOT NULL,
 windows jsonb NOT NULL CHECK (jsonb_typeof(windows) = 'array'),
 error boolean NOT NULL DEFAULT false
);
CREATE TABLE affinity_router.routing_policy (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 version bigint NOT NULL DEFAULT 1,
 mode text NOT NULL DEFAULT 'shadow' CHECK(mode IN ('shadow', 'live')),
 minimum_remaining double precision NOT NULL DEFAULT 5 CHECK(minimum_remaining BETWEEN 0 AND 100),
 freshness_seconds integer NOT NULL DEFAULT 300 CHECK(freshness_seconds BETWEEN 30 AND 3600),
 affinity_seconds integer NOT NULL DEFAULT 3600 CHECK(affinity_seconds BETWEEN 60 AND 86400)
);
INSERT INTO affinity_router.routing_policy (singleton) VALUES (true);
CREATE TABLE affinity_router.affinity_bindings (
 scope text PRIMARY KEY,
 account_id text NOT NULL,
 expires_at timestamptz NOT NULL
);
CREATE INDEX affinity_expiry ON affinity_router.affinity_bindings(expires_at);
CREATE TABLE affinity_router.routing_decisions (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 decided_at timestamptz NOT NULL DEFAULT now(),
 mode text NOT NULL,
 policy_version bigint NOT NULL,
 session_id text NOT NULL,
 model text NOT NULL,
 account_id text NOT NULL,
 reason text NOT NULL,
 candidate_count integer NOT NULL
);
CREATE INDEX decisions_time ON affinity_router.routing_decisions(decided_at DESC);
CREATE TABLE affinity_router.request_journal (
 id text PRIMARY KEY,
 replica_id text NOT NULL,
 model text NOT NULL,
 started_at timestamptz NOT NULL,
 completed_at timestamptz,
 outcome text NOT NULL DEFAULT 'pending'
);
CREATE TABLE affinity_router.plugin_heartbeat (
 replica_id text PRIMARY KEY,
 seen_at timestamptz NOT NULL DEFAULT now(),
 pending_events integer NOT NULL,
 rejected_events integer NOT NULL
);
