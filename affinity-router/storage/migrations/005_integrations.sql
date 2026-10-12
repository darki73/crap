CREATE TABLE affinity_router.integrations (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 version bigint NOT NULL DEFAULT 0,
 encrypted text NOT NULL DEFAULT '',
 lease_owner text NOT NULL DEFAULT '',
 lease_until timestamptz NOT NULL DEFAULT '-infinity'
);
INSERT INTO affinity_router.integrations(singleton) VALUES(true);
