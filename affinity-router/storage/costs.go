package storage

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5/pgxpool"
	"regexp"
	"strings"
	"time"
)

type Price struct {
	CacheWrite5mRate string    `json:"cacheWrite5mRate"`
	CacheWrite1hRate string    `json:"cacheWrite1hRate"`
	Provider         string    `json:"provider"`
	Model            string    `json:"model"`
	ServiceTier      string    `json:"serviceTier"`
	EffectiveFrom    time.Time `json:"effectiveFrom"`
	InputRate        string    `json:"inputRate"`
	CacheReadRate    string    `json:"cacheReadRate"`
	CacheWriteRate   string    `json:"cacheWriteRate"`
	OutputRate       string    `json:"outputRate"`
	ReasoningRate    string    `json:"reasoningRate"`
	Note             string    `json:"note"`
}

var decimalRate = regexp.MustCompile(`^(0|[1-9][0-9]{0,8})(\.[0-9]{1,8})?$`)

func AddPrice(ctx context.Context, pool *pgxpool.Pool, p Price) error {
	if strings.TrimSpace(p.Provider) == "" || strings.TrimSpace(p.Model) == "" || strings.TrimSpace(p.Note) == "" || p.EffectiveFrom.IsZero() {
		return errors.New("provider, model, effective date and rate source are required")
	}
	for _, rate := range []string{p.InputRate, p.CacheReadRate, p.OutputRate, p.ReasoningRate} {
		if !decimalRate.MatchString(rate) {
			return errors.New("rates must be nonnegative USD per million decimal values")
		}
	}

	var aggregate, five, hour any
	if p.Provider == "claude" || p.CacheWrite5mRate != "" || p.CacheWrite1hRate != "" {
		if p.CacheWriteRate != "" || !decimalRate.MatchString(p.CacheWrite5mRate) || !decimalRate.MatchString(p.CacheWrite1hRate) {
			return errors.New("both cache-duration rates are required; aggregate rate must be omitted")
		}
		five, hour = p.CacheWrite5mRate, p.CacheWrite1hRate
	} else {
		if !decimalRate.MatchString(p.CacheWriteRate) {
			return errors.New("cache-write rate is required")
		}
		aggregate = p.CacheWriteRate
	}
	_, err := pool.Exec(ctx, `INSERT INTO affinity_router.price_versions(provider,model,service_tier,effective_from,input_rate,cache_read_rate,cache_write_rate,output_rate,reasoning_rate,note,cache_write_5m_rate,cache_write_1h_rate) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, p.Provider, p.Model, p.ServiceTier, p.EffectiveFrom, p.InputRate, p.CacheReadRate, aggregate, p.OutputRate, p.ReasoningRate, p.Note, five, hour)
	return err
}

// EstimateUnpriced creates immutable estimates using decimal arithmetic. A later
// price edit never silently rewrites previous estimates. Unknown token categories
// and unmatched tiers remain unpriced. OAuth/unknown auth is API-equivalent only.
func EstimateUnpriced(ctx context.Context, pool *pgxpool.Pool, eventIDs ...string) error {
	filter := ""
	var args []any
	if len(eventIDs) > 0 {
		filter = " AND e.event_id=$1::uuid"
		args = append(args, eventIDs[0])
	}
	_, err := pool.Exec(ctx, `INSERT INTO affinity_router.cost_estimates(event_id,price_id,kind,usd,pricing_basis)
SELECT e.event_id,p.id,CASE WHEN e.auth_type IN ('api_key','api-key','apikey') THEN 'api_estimate' ELSE 'api_equivalent' END,
(e.input_uncached::numeric*p.input_rate + e.cache_read::numeric*p.cache_read_rate + CASE WHEN e.cache_write=0 THEN 0 WHEN p.cache_write_rate IS NOT NULL THEN e.cache_write::numeric*p.cache_write_rate ELSE e.cache_write_5m::numeric*p.cache_write_5m_rate + e.cache_write_1h::numeric*p.cache_write_1h_rate END + e.output_non_reasoning::numeric*p.output_rate + e.output_reasoning::numeric*p.reasoning_rate)/1000000, CASE WHEN e.cache_write=0 THEN 'no_cache_writes' WHEN p.cache_write_rate IS NOT NULL THEN 'aggregate_rate' ELSE 'observed_duration' END
FROM affinity_router.usage_with_cache e
JOIN LATERAL (SELECT * FROM affinity_router.price_versions p WHERE p.provider=e.provider AND p.model=e.model AND p.service_tier=e.service_tier AND p.effective_from<=e.started_at ORDER BY p.effective_from DESC LIMIT 1) p ON true
WHERE e.quality='complete' AND (e.cache_write=0 OR (p.cache_write_rate IS NOT NULL AND e.provider <> 'claude') OR (p.cache_write_5m_rate IS NOT NULL AND e.cache_write_5m IS NOT NULL)) AND NOT EXISTS(SELECT 1 FROM affinity_router.cost_estimates c WHERE c.event_id=e.event_id)
`+filter+` ON CONFLICT(event_id) DO NOTHING`, args...)
	return err
}
