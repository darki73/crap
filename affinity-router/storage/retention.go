package storage

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// PruneOperational never deletes usage, prices, credentials, journal entries or
// rejected spool records. Each applied batch is bounded to 10,000 rows/table.
// A backup remains required before intentionally applying this operation.
func PruneOperational(ctx context.Context, pool *pgxpool.Pool, before time.Time, apply bool) (map[string]int64, error) {
	result := map[string]int64{}
	for _, entry := range []struct{ name, key, column string }{
		{"affinity_bindings", "scope", "expires_at"},
		{"routing_decisions", "id", "decided_at"},
		{"plugin_heartbeat", "replica_id", "seen_at"},
	} {
		table := "affinity_router." + entry.name
		if !apply {
			var count int64
			if err := pool.QueryRow(ctx, "SELECT count(*) FROM "+table+" WHERE "+entry.column+" < $1", before).Scan(&count); err != nil {
				return nil, err
			}
			result[entry.name] = count
		} else {
			deleted, err := pool.Exec(ctx, "DELETE FROM "+table+" WHERE "+entry.column+" < $1 AND "+entry.key+" IN (SELECT "+entry.key+" FROM "+table+" WHERE "+entry.column+" < $1 ORDER BY "+entry.column+" LIMIT 10000)", before)
			if err != nil {
				return nil, err
			}
			result[entry.name] = deleted.RowsAffected()
		}
	}
	return result, nil
}
