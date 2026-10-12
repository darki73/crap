package storage

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrInvalidJournal = errors.New("invalid journal event")

type JournalEvent struct {
	TraceRef                      *string
	ID, ReplicaID, Model, Outcome string
	StartedAt, CompletedAt        time.Time
}

// Terminal observations are immutable. Late admission delivery cannot reopen a
// completed request, and a conflicting completion is retained in the spool.
func AppendJournal(ctx context.Context, pool *pgxpool.Pool, e JournalEvent) error {
	if e.ID == "" || len(e.ID) > 256 || e.ReplicaID == "" || len(e.ReplicaID) > 256 || e.StartedAt.IsZero() {
		return ErrInvalidJournal
	}
	var completed any
	if e.CompletedAt.IsZero() {
		if e.Outcome != "" && e.Outcome != "pending" {
			return ErrInvalidJournal
		}
		e.Outcome = "pending"
	} else {
		if e.CompletedAt.Before(e.StartedAt) {
			return ErrInvalidJournal
		}
		switch e.Outcome {
		case "succeeded", "failed", "rejected", "canceled":
		default:
			return ErrInvalidJournal
		}
		completed = e.CompletedAt
	}
	result, err := pool.Exec(ctx, `INSERT INTO affinity_router.request_journal(id,replica_id,model,started_at,completed_at,outcome,trace_ref) VALUES($1,$2,$3,$4,$5,$6,$7)
 ON CONFLICT(id) DO UPDATE SET trace_ref=COALESCE(request_journal.trace_ref,EXCLUDED.trace_ref), completed_at=COALESCE(EXCLUDED.completed_at,request_journal.completed_at), outcome=CASE WHEN EXCLUDED.completed_at IS NOT NULL THEN EXCLUDED.outcome ELSE request_journal.outcome END
 WHERE request_journal.replica_id=EXCLUDED.replica_id AND (request_journal.trace_ref IS NULL OR EXCLUDED.trace_ref IS NULL OR request_journal.trace_ref=EXCLUDED.trace_ref) AND (EXCLUDED.completed_at IS NULL OR request_journal.completed_at IS NULL OR (request_journal.completed_at=EXCLUDED.completed_at AND request_journal.outcome=EXCLUDED.outcome))`, e.ID, e.ReplicaID, e.Model, e.StartedAt, completed, e.Outcome, e.TraceRef)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return ErrEventConflict
	}
	return nil
}
