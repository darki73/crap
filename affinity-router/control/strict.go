package control

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"cliproxy-affinity-router/policy"
	"github.com/jackc/pgx/v5"
)

type StrictPick struct {
	SessionID      string             `json:"sessionId"`
	ParentID       string             `json:"parentId"`
	Model          string             `json:"model"`
	Candidates     []policy.Candidate `json:"candidates"`
	LegacySessions []string           `json:"legacySessions,omitempty"`
}

func (s *Server) strictPick(ctx context.Context, p StrictPick) (policy.Decision, error) {
	if p.SessionID == "" || p.Model == "" || len(p.Candidates) > 1000 || len(p.LegacySessions) > 12 {
		return policy.Decision{}, errors.New("invalid strict selection")
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return policy.Decision{}, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	// One transaction resolves family merges, bindings and the filling account.
	// Global serialization is intentional for the single-active alpha.
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(702361880196)"); err != nil {
		return policy.Decision{}, err
	}
	family := p.SessionID
	var existing string
	err = tx.QueryRow(ctx, "SELECT family_id FROM affinity_router.strict_sessions WHERE session_id=$1", p.SessionID).Scan(&existing)
	if err == nil {
		family = existing
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return policy.Decision{}, err
	}
	if p.ParentID != "" && p.ParentID != p.SessionID {
		parent := p.ParentID
		err = tx.QueryRow(ctx, "SELECT family_id FROM affinity_router.strict_sessions WHERE session_id=$1", p.ParentID).Scan(&parent)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return policy.Decision{}, err
		}
		if parent == "" {
			parent = p.ParentID
		}
		if _, err = tx.Exec(ctx, `INSERT INTO affinity_router.strict_families(id) VALUES($1) ON CONFLICT DO NOTHING`, parent); err != nil {
			return policy.Decision{}, err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO affinity_router.strict_sessions(session_id,family_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, p.ParentID, parent); err != nil {
			return policy.Decision{}, err
		}
		if existing != "" && existing != parent {
			if _, err = tx.Exec(ctx, `UPDATE affinity_router.strict_sessions SET family_id=$1 WHERE family_id=$2`, parent, existing); err != nil {
				return policy.Decision{}, err
			}
		}
		family = parent
	}
	if _, err = tx.Exec(ctx, `INSERT INTO affinity_router.strict_families(id) VALUES($1) ON CONFLICT DO NOTHING`, family); err != nil {
		return policy.Decision{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO affinity_router.strict_sessions(session_id,family_id) VALUES($1,$2) ON CONFLICT(session_id) DO UPDATE SET family_id=$2`, p.SessionID, family); err != nil {
		return policy.Decision{}, err
	}
	var bound, filling string
	if err = tx.QueryRow(ctx, `SELECT account_id FROM affinity_router.strict_families WHERE id=$1`, family).Scan(&bound); err != nil {
		return policy.Decision{}, err
	}
	if bound == "" && len(p.LegacySessions) > 0 {
		// Keep historical bindings intact for rollback. Import only an exact live
		// session match; the latest actual assignment wins across model variants.
		err = tx.QueryRow(ctx, `SELECT account_id FROM affinity_router.routing_decisions WHERE mode='live' AND session_id=ANY($1) AND account_id<>'' ORDER BY decided_at DESC,id DESC LIMIT 1`, p.LegacySessions).Scan(&bound)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return policy.Decision{}, err
		}
	}
	if err = tx.QueryRow(ctx, `SELECT account_id FROM affinity_router.strict_pool WHERE singleton`).Scan(&filling); err != nil {
		return policy.Decision{}, err
	}
	var candidates []policy.Candidate
	for _, input := range p.Candidates {
		var blocked bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM affinity_router.strict_account_blocks WHERE account_id=$1 AND model IN ('',$2) AND revision=$3 AND (until_at IS NULL OR until_at>now()))`, input.ID, p.Model, input.Revision).Scan(&blocked); err != nil {
			return policy.Decision{}, err
		}
		if blocked {
			continue
		}
		c := policy.Candidate{ID: input.ID, Provider: input.Provider}
		var raw []byte
		err = tx.QueryRow(ctx, `SELECT observed_at,windows,error FROM affinity_router.quota_snapshots WHERE account_id=$1`, c.ID).Scan(&c.ObservedAt, &raw, &c.Error)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return policy.Decision{}, err
		}
		if len(raw) > 0 {
			if err = json.Unmarshal(raw, &c.Windows); err != nil {
				return policy.Decision{}, err
			}
		}
		candidates = append(candidates, c)
	}
	var version int64
	var minimumRemaining float64
	if err = tx.QueryRow(ctx, `SELECT version,minimum_remaining FROM affinity_router.routing_policy WHERE singleton FOR SHARE`).Scan(&version, &minimumRemaining); err != nil {
		return policy.Decision{}, err
	}
	d := policy.ChooseStrict(time.Now(), minimumRemaining, p.Model, bound, filling, candidates)
	if d.AccountID != "" {
		if _, err = tx.Exec(ctx, `UPDATE affinity_router.strict_families SET account_id=$2,updated_at=now() WHERE id=$1`, family, d.AccountID); err != nil {
			return d, err
		}
		if d.AccountID != bound || filling == "" {
			if _, err = tx.Exec(ctx, `UPDATE affinity_router.strict_pool SET account_id=$1 WHERE singleton`, d.AccountID); err != nil {
				return d, err
			}
		}
	}
	_, err = tx.Exec(ctx, `INSERT INTO affinity_router.routing_decisions(mode,policy_version,session_id,model,account_id,reason,candidate_count) VALUES('live',$6,$1,$2,$3,$4,$5)`, p.SessionID, p.Model, d.AccountID, d.Reason, len(candidates), version)
	if err != nil {
		return d, err
	}
	return d, tx.Commit(ctx)
}
