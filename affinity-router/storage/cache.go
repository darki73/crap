package storage

import (
	"context"
	"errors"
	"math"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

// CacheObservation contains only provider-reported counters and an opaque join key.
type CacheObservation struct {
	ResponseRef                            string
	CacheWrite, CacheWrite5m, CacheWrite1h int64
}

func AppendCacheObservation(ctx context.Context, pool *pgxpool.Pool, o CacheObservation) error {
	if !strings.HasPrefix(o.ResponseRef, "v1:") || o.CacheWrite5m < 0 || o.CacheWrite1h < 0 || o.CacheWrite5m > math.MaxInt64-o.CacheWrite1h || o.CacheWrite != o.CacheWrite5m+o.CacheWrite1h {
		return errors.New("invalid cache observation")
	}
	_, err := pool.Exec(ctx, `INSERT INTO affinity_router.cache_observations(response_ref,cache_write,cache_write_5m,cache_write_1h) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, o.ResponseRef, o.CacheWrite, o.CacheWrite5m, o.CacheWrite1h)
	if err != nil {
		return err
	}
	var same bool
	err = pool.QueryRow(ctx, `SELECT cache_write=$2 AND cache_write_5m=$3 AND cache_write_1h=$4 FROM affinity_router.cache_observations WHERE response_ref=$1`, o.ResponseRef, o.CacheWrite, o.CacheWrite5m, o.CacheWrite1h).Scan(&same)
	if err == nil && !same {
		return ErrEventConflict
	}
	return err
}
