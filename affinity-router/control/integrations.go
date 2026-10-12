package control

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
)

type integrationDocument struct {
	Version   int64  `json:"version"`
	Encrypted string `json:"encrypted"`
}

func (s *Server) integrations(ctx context.Context) (integrationDocument, error) {
	var d integrationDocument
	err := s.Pool.QueryRow(ctx, "SELECT version,encrypted FROM affinity_router.integrations WHERE singleton").Scan(&d.Version, &d.Encrypted)
	return d, err
}
func (s *Server) saveIntegrations(ctx context.Context, d integrationDocument) (integrationDocument, error) {
	if len(d.Encrypted) > 262144 || len(d.Encrypted) < 40 {
		return d, errors.New("invalid encrypted integration configuration")
	}
	err := s.Pool.QueryRow(ctx, "UPDATE affinity_router.integrations SET version=version+1,encrypted=$1 WHERE singleton AND version=$2 RETURNING version", d.Encrypted, d.Version).Scan(&d.Version)
	return d, err
}
func (s *Server) integrationLease(ctx context.Context, owner string) (map[string]bool, error) {
	if len(owner) < 16 || len(owner) > 64 {
		return nil, errors.New("invalid lease owner")
	}
	var got string
	err := s.Pool.QueryRow(ctx, "UPDATE affinity_router.integrations SET lease_owner=$1,lease_until=now()+interval '90 seconds' WHERE singleton AND (lease_owner=$1 OR lease_until<now()) RETURNING lease_owner", owner).Scan(&got)
	if errors.Is(err, pgx.ErrNoRows) {
		return map[string]bool{"granted": false}, nil
	}
	return map[string]bool{"granted": err == nil}, err
}
func (s *Server) integrationSummary(ctx context.Context) (map[string]any, error) {
	result := map[string]any{}
	for name, query := range map[string]string{
		"daily":  `SELECT json_build_object('requests',count(*),'tokens',COALESCE(sum(reported_total),0)::text,'unknown',count(*) FILTER(WHERE reported_total IS NULL),'failed',count(*) FILTER(WHERE outcome='failed')) FROM affinity_router.usage_events WHERE started_at>=now()-interval '24 hours'`,
		"quotas": `SELECT COALESCE(json_agg(t),'[]') FROM (SELECT account_id,provider,windows,observed_at,error FROM affinity_router.quota_snapshots) t`,
	} {
		var raw []byte
		if err := s.Pool.QueryRow(ctx, query).Scan(&raw); err != nil {
			return nil, err
		}
		var value any
		if err := json.Unmarshal(raw, &value); err != nil {
			return nil, err
		}
		result[name] = value
	}
	return result, nil
}
