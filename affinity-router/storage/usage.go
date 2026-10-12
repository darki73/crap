package storage

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrEventConflict = errors.New("event ID already exists with different data")

// UsageEvent describes one terminal upstream attempt. IDs must be opaque;
// provider credentials, raw session IDs, email addresses and prompts are excluded.
// Nil token counts mean unknown. Complete categories are mutually exclusive.
type UsageEvent struct {
	TraceRef                                           *string
	ResponseRef                                        *string
	AuthType, ServiceTier, AccountingSource            string
	EventID, RequestID, ReplicaID, AccountID, ClientID string
	SessionID                                          *string
	Provider, Model                                    string
	StartedAt, FinishedAt                              time.Time
	Outcome, Quality                                   string
	InputUncached, CacheRead, CacheWrite               *int64
	OutputNonReasoning, OutputReasoning, ReportedTotal *int64
}

// AppendUsage is idempotent for an identical event. Conflicting redelivery is an
// error, never an overwrite. PostgreSQL constraints validate accounting even for
// callers outside this package. Only a successful return acknowledges durability.
func AppendUsage(ctx context.Context, pool *pgxpool.Pool, event UsageEvent) (bool, error) {
	args := []any{event.EventID, event.RequestID, event.ReplicaID, event.AccountID, event.ClientID,
		event.SessionID, event.Provider, event.Model, event.StartedAt, event.FinishedAt,
		event.Outcome, event.Quality, event.InputUncached, event.CacheRead, event.CacheWrite,
		event.OutputNonReasoning, event.OutputReasoning, event.ReportedTotal, event.AuthType, event.ServiceTier, event.AccountingSource, event.ResponseRef, event.TraceRef}
	result, errInsert := pool.Exec(ctx, `INSERT INTO affinity_router.usage_events (
event_id, request_id, replica_id, account_id, client_id, session_id, provider, model,
started_at, finished_at, outcome, quality, input_uncached, cache_read, cache_write,
output_non_reasoning, output_reasoning, reported_total,auth_type,service_tier,accounting_source,response_ref,trace_ref)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
ON CONFLICT (event_id) DO NOTHING`, args...)
	if errInsert != nil {
		return false, fmt.Errorf("append usage: %w", errInsert)
	}
	if result.RowsAffected() == 1 {
		return true, nil
	}
	// Separate statement sees a concurrently committed conflicting insert even
	// when it was invisible to the INSERT statement's initial snapshot.
	var same bool
	errCompare := pool.QueryRow(ctx, `SELECT ROW(request_id, replica_id, account_id, client_id,
session_id, provider, model, started_at, finished_at, outcome, quality, input_uncached,
cache_read, cache_write, output_non_reasoning, output_reasoning, reported_total,auth_type,service_tier,accounting_source,response_ref,trace_ref)
IS NOT DISTINCT FROM ROW($2::text,$3::text,$4::text,$5::text,$6::text,$7::text,$8::text,
$9::timestamptz,$10::timestamptz,$11::text,$12::text,$13::bigint,$14::bigint,$15::bigint,
$16::bigint,$17::bigint,$18::bigint,$19::text,$20::text,$21::text,$22::text,$23::text)
FROM affinity_router.usage_events WHERE event_id=$1`, args...).Scan(&same)
	if errCompare != nil {
		return false, fmt.Errorf("compare existing usage: %w", errCompare)
	}
	if !same {
		return false, ErrEventConflict
	}
	return false, nil
}
