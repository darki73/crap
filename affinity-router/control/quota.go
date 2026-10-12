package control

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"cliproxy-affinity-router/policy"

	"github.com/jackc/pgx/v5"
	log "github.com/sirupsen/logrus"
)

// Merge each window by observation time; a refreshed five-hour window must not
// freshen or overwrite a newer weekly observation from another replica.
func mergeQuotaWindows(old []policy.Window, oldAt time.Time, next []policy.Window, nextAt time.Time) []policy.Window {
	result := make([]policy.Window, 0, len(old)+len(next))
	indexes := map[string]int{}
	for _, group := range []struct {
		windows []policy.Window
		at      time.Time
	}{{old, oldAt}, {next, nextAt}} {
		for _, w := range group.windows {
			if w.ObservedAt == nil {
				stamp := group.at.UnixMilli()
				w.ObservedAt = &stamp
			}
			if i, ok := indexes[w.Label]; ok {
				if *w.ObservedAt > *result[i].ObservedAt {
					result[i] = w
				}
			} else {
				indexes[w.Label] = len(result)
				result = append(result, w)
			}
		}
	}
	return result
}

func (s *Server) saveQuota(ctx context.Context, id, provider, plan string, at time.Time, windows []policy.Window, failed bool) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() {
		if rollbackErr := tx.Rollback(context.WithoutCancel(ctx)); rollbackErr != nil && !errors.Is(rollbackErr, pgx.ErrTxClosed) {
			log.Warn("Quota snapshot rollback failed")
		}
	}()
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,1))", id); err != nil {
		return err
	}
	var previous []byte
	var previousAt time.Time
	var previousPlan string
	var previousError bool
	err = tx.QueryRow(ctx, "SELECT windows,observed_at,plan,error FROM affinity_router.quota_snapshots WHERE account_id=$1", id).Scan(&previous, &previousAt, &previousPlan, &previousError)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	var old []policy.Window
	if len(previous) > 0 {
		if err = json.Unmarshal(previous, &old); err != nil {
			return err
		}
	}
	merged := mergeQuotaWindows(old, previousAt, windows, at)
	if at.Before(previousAt) {
		at, plan, failed = previousAt, previousPlan, previousError
	}
	if plan == "" {
		plan = previousPlan
	}
	raw, err := json.Marshal(merged)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO affinity_router.quota_snapshots(account_id,provider,plan,observed_at,windows,error) VALUES($1,$2,$3,$4,$5,$6)
ON CONFLICT(account_id) DO UPDATE SET provider=$2,plan=$3,observed_at=$4,windows=$5,error=$6`, id, provider, plan, at, raw, failed)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}
