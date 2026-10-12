-- Permanent conversation families and a single filling account. Legacy tables
-- remain intact for historical reports and rollback; no credentials are copied.
CREATE TABLE affinity_router.strict_families (
 id text PRIMARY KEY,
 account_id text NOT NULL DEFAULT '',
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE affinity_router.strict_sessions (
 session_id text PRIMARY KEY,
 family_id text NOT NULL REFERENCES affinity_router.strict_families(id)
);
CREATE TABLE affinity_router.strict_pool (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 account_id text NOT NULL DEFAULT ''
);
INSERT INTO affinity_router.strict_pool(singleton) VALUES(true);
CREATE TABLE affinity_router.strict_account_blocks (
 account_id text NOT NULL,
 model text NOT NULL DEFAULT '',
 reason text NOT NULL,
 revision text NOT NULL DEFAULT '',
 until_at timestamptz,
 PRIMARY KEY(account_id,model)
);
