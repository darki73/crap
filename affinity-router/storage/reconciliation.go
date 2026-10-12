package storage

import (
	"context"
	"github.com/jackc/pgx/v5/pgxpool"
	"time"
)

type Coverage struct {
	MatchedTraces         int64 `json:"matchedTraces"`
	CompletedWithoutUsage int64 `json:"completedWithoutUsage"`
	UnlinkedJournal       int64 `json:"unlinkedJournal"`
	UnlinkedUsage         int64 `json:"unlinkedUsage"`
}

// Coverage reports observations, never inferred lost tokens. Multiple upstream
// attempts may share one inbound trace. A grace period permits callback replay.
func Reconcile(ctx context.Context, pool *pgxpool.Pool, before time.Time) (Coverage, error) {
	var c Coverage
	err := pool.QueryRow(ctx, `SELECT
 (SELECT count(DISTINCT j.trace_ref) FROM affinity_router.request_journal j WHERE j.trace_ref IS NOT NULL AND EXISTS(SELECT 1 FROM affinity_router.usage_events u WHERE u.trace_ref=j.trace_ref)),
 (SELECT count(*) FROM affinity_router.request_journal j WHERE j.trace_ref IS NOT NULL AND j.completed_at < $1 AND j.outcome='succeeded' AND NOT EXISTS(SELECT 1 FROM affinity_router.usage_events u WHERE u.trace_ref=j.trace_ref)),
 (SELECT count(*) FROM affinity_router.request_journal WHERE trace_ref IS NULL),
 (SELECT count(*) FROM affinity_router.usage_events WHERE trace_ref IS NULL)`, before).Scan(&c.MatchedTraces, &c.CompletedWithoutUsage, &c.UnlinkedJournal, &c.UnlinkedUsage)
	return c, err
}
