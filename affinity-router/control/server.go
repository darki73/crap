package control

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"cliproxy-affinity-router/identity"
	"cliproxy-affinity-router/policy"
	"cliproxy-affinity-router/storage"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	log "github.com/sirupsen/logrus"
)

type Server struct {
	Strict          bool
	Pool            *pgxpool.Pool
	Token           string
	IdentityKey     []byte
	MaintenanceFile string
	maintenance     sync.RWMutex
}
type Pick struct {
	SessionID  string             `json:"sessionId"`
	Model      string             `json:"model"`
	Candidates []policy.Candidate `json:"candidates"`
}

func (s *Server) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		if r.URL.Path == "/healthz" && r.Method == "GET" {
			if err := s.Pool.Ping(r.Context()); err != nil {
				respond(w, 503, map[string]string{"error": "database unavailable"})
			} else {
				respond(w, 200, map[string]string{"status": "ok"})
			}
			return
		}
		if s.Token == "" || subtle.ConstantTimeCompare([]byte(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")), []byte(s.Token)) != 1 {
			respond(w, 401, map[string]string{"error": "unauthorized"})
			return
		}
		if r.URL.Path == "/maintenance" {
			s.handleMaintenance(w, r)
			return
		}
		s.maintenance.RLock()
		defer s.maintenance.RUnlock()
		if s.MaintenanceFile != "" {
			if _, err := os.Stat(s.MaintenanceFile); !os.IsNotExist(err) {
				respond(w, 503, map[string]string{"error": "database migration maintenance is active"})
				return
			}
		}
		var result any = map[string]bool{"ok": true}
		var err error
		switch r.Method + " " + r.URL.Path {
		case "POST /strict/pick":
			var p StrictPick
			err = decode(w, r, &p)
			if err == nil {
				result, err = s.strictPick(r.Context(), p)
			}
		case "POST /strict/failure":
			var f struct {
				AccountID string `json:"accountId"`
				Model     string `json:"model"`
				Revision  string `json:"revision"`
				Reason    string `json:"reason"`
			}
			err = decode(w, r, &f)
			if err == nil && f.AccountID != "" && (f.Reason == "invalid_credentials" || f.Reason == "model_unavailable") {
				if f.Reason == "invalid_credentials" {
					f.Model = ""
				}
				_, err = s.Pool.Exec(r.Context(), `INSERT INTO affinity_router.strict_account_blocks(account_id,model,reason,revision) VALUES($1,$2,$3,$4) ON CONFLICT(account_id,model) DO UPDATE SET reason=$3,revision=$4`, f.AccountID, f.Model, f.Reason, f.Revision)
			} else if err == nil {
				err = errors.New("invalid failure observation")
			}
		case "GET /ready":
			var ready bool
			err = s.Pool.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM affinity_router.plugin_heartbeat WHERE seen_at > now() - interval '30 seconds' AND pending_events < 10000 AND rejected_events = 0)`).Scan(&ready)
			if err == nil && !ready {
				respond(w, 503, map[string]string{"error": "plugin heartbeat or delivery queue needs attention"})
				return
			}
		case "GET /integrations":
			result, err = s.integrations(r.Context())
		case "PUT /integrations":
			var document integrationDocument
			err = decode(w, r, &document)
			if err == nil {
				result, err = s.saveIntegrations(r.Context(), document)
			}
			if errors.Is(err, pgx.ErrNoRows) {
				respond(w, 409, map[string]string{"error": "Integration settings changed. Reload before saving."})
				return
			}
		case "POST /integrations/lease":
			var lease struct {
				Owner string `json:"owner"`
			}
			err = decode(w, r, &lease)
			if err == nil {
				result, err = s.integrationLease(r.Context(), lease.Owner)
			}
		case "GET /integrations/summary":
			result, err = s.integrationSummary(r.Context())
		case "POST /usage":
			var e storage.UsageEvent
			err = decode(w, r, &e)
			if err == nil {
				_, err = storage.AppendUsage(r.Context(), s.Pool, e)
			}
			if err == nil {
				err = storage.EstimateUnpriced(r.Context(), s.Pool, e.EventID)
			}
		case "POST /cache-observations":
			var observation storage.CacheObservation
			err = decode(w, r, &observation)
			if err == nil {
				err = storage.AppendCacheObservation(r.Context(), s.Pool, observation)
			}
			if err == nil {
				err = storage.EstimateUnpriced(r.Context(), s.Pool)
			}
		case "POST /prices":
			var price storage.Price
			err = decode(w, r, &price)
			if err == nil {
				err = storage.AddPrice(r.Context(), s.Pool, price)
			}
			if err == nil {
				err = storage.EstimateUnpriced(r.Context(), s.Pool)
			}
		case "POST /journal":
			var e storage.JournalEvent
			err = decode(w, r, &e)
			if err == nil {
				err = storage.AppendJournal(r.Context(), s.Pool, e)
			}
		case "POST /heartbeat":
			var e struct {
				ReplicaID         string
				Pending, Rejected int
			}
			err = decode(w, r, &e)
			if err == nil && (e.ReplicaID == "" || e.Pending < 0 || e.Rejected < 0) {
				err = errors.New("invalid heartbeat")
			}
			if err == nil {
				_, err = s.Pool.Exec(r.Context(), `INSERT INTO affinity_router.plugin_heartbeat(replica_id,pending_events,rejected_events) VALUES($1,$2,$3) ON CONFLICT(replica_id) DO UPDATE SET seen_at=now(),pending_events=$2,rejected_events=$3`, e.ReplicaID, e.Pending, e.Rejected)
			}
		case "POST /quotas":
			var q struct {
				AccountID string          `json:"accountId"`
				Provider  string          `json:"provider"`
				Plan      string          `json:"plan"`
				CheckedAt int64           `json:"checkedAt"`
				Windows   []policy.Window `json:"windows"`
				Error     bool            `json:"error"`
			}
			err = decode(w, r, &q)
			if err == nil && (q.AccountID == "" || q.Provider == "" || q.CheckedAt <= 0 || q.CheckedAt > time.Now().Add(time.Minute).UnixMilli() || len(q.Windows) > 100) {
				err = errors.New("invalid snapshot")
			}
			if err == nil {
				id, errID := identity.Reference(s.IdentityKey, "local", "account", q.AccountID)
				err = errID
				if q.Windows == nil {
					q.Windows = []policy.Window{}
				}
				if err == nil {
					err = s.saveQuota(r.Context(), id, q.Provider, q.Plan, time.UnixMilli(q.CheckedAt), q.Windows, q.Error)
				}
			}
		case "POST /pick":
			var p Pick
			err = decode(w, r, &p)
			if err == nil {
				result, err = s.pick(r.Context(), p)
			}
		case "GET /state":
			result, err = s.state(r.Context())
		case "PUT /policy":
			var p policy.Config
			err = decode(w, r, &p)
			if err == nil && (p.MinimumRemaining < 0 || p.MinimumRemaining > 100 || (!s.Strict && (p.Mode != "shadow" && p.Mode != "live" || p.FreshnessSeconds < 30 || p.FreshnessSeconds > 3600 || p.AffinitySeconds < 60 || p.AffinitySeconds > 86400))) {
				err = errors.New("invalid policy")
			}
			if err == nil {
				var n int64
				if s.Strict {
					// Only the reserve is editable in strict mode. Legacy mode, expiry and
					// freshness settings must not alter strict routing semantics.
					err = s.Pool.QueryRow(r.Context(), `UPDATE affinity_router.routing_policy SET version=version+1,minimum_remaining=$1 WHERE singleton AND version=$2 RETURNING version`, p.MinimumRemaining, p.Version).Scan(&n)
				} else {
					err = s.Pool.QueryRow(r.Context(), `UPDATE affinity_router.routing_policy SET version=version+1,mode=$1,minimum_remaining=$2,freshness_seconds=$3,affinity_seconds=$4 WHERE singleton AND version=$5 RETURNING version`, p.Mode, p.MinimumRemaining, p.FreshnessSeconds, p.AffinitySeconds, p.Version).Scan(&n)
				}
				if errors.Is(err, pgx.ErrNoRows) {
					respond(w, 409, map[string]string{"error": "Policy changed. Refresh before saving."})
					return
				}
			}
		default:
			respond(w, 404, map[string]string{"error": "not found"})
			return
		}
		if err != nil {
			if errors.Is(err, storage.ErrInvalidJournal) {
				respond(w, 422, map[string]string{"error": "invalid journal event"})
			} else if errors.Is(err, storage.ErrEventConflict) {
				respond(w, 409, map[string]string{"error": "conflicting event"})
			} else {
				log.WithField("operation", r.URL.Path).Warn("Affinity operation failed")
				status := http.StatusServiceUnavailable
				var postgresError *pgconn.PgError
				if errors.As(err, &postgresError) && (strings.HasPrefix(postgresError.Code, "22") || strings.HasPrefix(postgresError.Code, "23")) {
					status = http.StatusUnprocessableEntity
				}
				respond(w, status, map[string]string{"error": "Operation failed validation or storage. Check service health."})
			}
			return
		}
		respond(w, 200, result)
	})
}
func respond(w http.ResponseWriter, status int, value any) {
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func decode(w http.ResponseWriter, r *http.Request, value any) error {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return errors.New("unexpected trailing JSON")
	}
	return nil
}

func (s *Server) pick(ctx context.Context, p Pick) (policy.Decision, error) {
	if p.SessionID == "" || p.Model == "" || len(p.Candidates) == 0 || len(p.Candidates) > 1000 {
		return policy.Decision{}, errors.New("invalid selection context")
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return policy.Decision{}, err
	}
	defer func() {
		if e := tx.Rollback(context.WithoutCancel(ctx)); e != nil && !errors.Is(e, pgx.ErrTxClosed) {
			log.Warn("Affinity decision rollback failed")
		}
	}()
	// Serialize a conversation's first assignment across control-service replicas.
	scope := p.SessionID + "/" + p.Model
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", scope); err != nil {
		return policy.Decision{}, err
	}
	var cfg policy.Config
	err = tx.QueryRow(ctx, "SELECT version,mode,minimum_remaining,freshness_seconds,affinity_seconds FROM affinity_router.routing_policy WHERE singleton").Scan(&cfg.Version, &cfg.Mode, &cfg.MinimumRemaining, &cfg.FreshnessSeconds, &cfg.AffinitySeconds)
	if err != nil {
		return policy.Decision{}, err
	}
	// Shadow and live bindings are separate so a proposed assignment never becomes
	// a live binding without the live scheduler making that decision itself.
	scope = cfg.Mode + "/" + scope
	var now time.Time
	if err = tx.QueryRow(ctx, "SELECT now()").Scan(&now); err != nil {
		return policy.Decision{}, err
	}
	var bound string
	err = tx.QueryRow(ctx, "SELECT account_id FROM affinity_router.affinity_bindings WHERE scope=$1 AND expires_at>$2", scope, now).Scan(&bound)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return policy.Decision{}, err
	}
	candidates := make([]policy.Candidate, 0, len(p.Candidates))
	for _, input := range p.Candidates {
		c := policy.Candidate{ID: input.ID, Provider: input.Provider}
		var windows []byte
		err = tx.QueryRow(ctx, "SELECT observed_at,windows,error FROM affinity_router.quota_snapshots WHERE account_id=$1 AND provider=$2", c.ID, c.Provider).Scan(&c.ObservedAt, &windows, &c.Error)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return policy.Decision{}, err
		}
		if len(windows) > 0 {
			if err = json.Unmarshal(windows, &c.Windows); err != nil {
				return policy.Decision{}, err
			}
		}
		candidates = append(candidates, c)
	}
	d := policy.Choose(now, cfg, p.Model, bound, candidates)
	if d.AccountID != "" {
		_, err = tx.Exec(ctx, `INSERT INTO affinity_router.affinity_bindings(scope,account_id,expires_at) VALUES($1,$2,$3) ON CONFLICT(scope) DO UPDATE SET account_id=$2,expires_at=$3`, scope, d.AccountID, now.Add(time.Duration(cfg.AffinitySeconds)*time.Second))
		if err != nil {
			return d, err
		}
	}
	_, err = tx.Exec(ctx, "INSERT INTO affinity_router.routing_decisions(mode,policy_version,session_id,model,account_id,reason,candidate_count) VALUES($1,$2,$3,$4,$5,$6,$7)", cfg.Mode, cfg.Version, p.SessionID, p.Model, d.AccountID, d.Reason, len(candidates))
	if err != nil {
		return d, err
	}
	return d, tx.Commit(ctx)
}

func (s *Server) state(ctx context.Context) (map[string]any, error) {
	var cfg policy.Config
	if err := s.Pool.QueryRow(ctx, "SELECT version,mode,minimum_remaining,freshness_seconds,affinity_seconds FROM affinity_router.routing_policy WHERE singleton").Scan(&cfg.Version, &cfg.Mode, &cfg.MinimumRemaining, &cfg.FreshnessSeconds, &cfg.AffinitySeconds); err != nil {
		return nil, err
	}
	result := map[string]any{"policy": cfg, "strictRouting": s.Strict}
	coverage, err := storage.Reconcile(ctx, s.Pool, time.Now().Add(-30*time.Second))
	if err != nil {
		return nil, err
	}
	result["coverage"] = coverage
	queries := map[string]string{
		"clients":   `SELECT COALESCE(json_agg(t),'[]') FROM (SELECT client_id id,count(*) attempts,sum(reported_total)::text tokens,count(reported_total) known_totals FROM affinity_router.usage_events GROUP BY client_id ORDER BY count(*) DESC LIMIT 100) t`,
		"sessions":  `SELECT COALESCE(json_agg(t),'[]') FROM (SELECT session_id id,count(*) attempts,sum(reported_total)::text tokens,count(reported_total) known_totals FROM affinity_router.usage_events WHERE session_id IS NOT NULL GROUP BY session_id ORDER BY count(*) DESC LIMIT 100) t`,
		"costs":     `SELECT COALESCE(json_agg(t),'[]') FROM (SELECT kind,pricing_basis,count(*) attempts,sum(usd)::text usd FROM affinity_router.cost_estimates GROUP BY kind,pricing_basis ORDER BY kind,pricing_basis) t`,
		"prices":    `SELECT COALESCE(json_agg(t),'[]') FROM (SELECT id,provider,model,service_tier,effective_from,input_rate::text,cache_read_rate::text,cache_write_rate::text,cache_write_5m_rate::text,cache_write_1h_rate::text,output_rate::text,reasoning_rate::text,note FROM affinity_router.price_versions ORDER BY id DESC LIMIT 100) t`,
		"summary":   `SELECT json_build_object('events',count(*),'reportedTokens',sum(reported_total)::text,'knownTotals',count(reported_total),'complete',count(*) FILTER(WHERE quality='complete'),'failed',count(*) FILTER(WHERE outcome='failed'),'inputUncached',sum(input_uncached)::text,'output',sum(output_non_reasoning)::text,'reasoning',sum(output_reasoning)::text,'cacheRead',sum(cache_read)::text,'cacheWrite',sum(cache_write)::text) FROM affinity_router.usage_events`,
		"cache":     `SELECT json_build_object('fiveMinute',sum(cache_write_5m)::text,'oneHour',sum(cache_write_1h)::text,'unknownTokens',sum(cache_write) FILTER(WHERE cache_write>0 AND cache_write_5m IS NULL)::text,'unknownRequests',count(*) FILTER(WHERE cache_write>0 AND cache_write_5m IS NULL)) FROM affinity_router.usage_with_cache WHERE provider='claude'`,
		"groups":    `SELECT COALESCE(json_agg(t),'[]') FROM (SELECT provider,model,account_id,service_tier, count(*) attempts,sum(reported_total)::text tokens,count(reported_total) known_totals FROM affinity_router.usage_events GROUP BY provider,model,account_id,service_tier ORDER BY count(*) DESC LIMIT 100) t`,
		"recent":    `SELECT COALESCE(json_agg(t),'[]') FROM (SELECT event_id,provider,model,account_id,started_at,outcome,quality,reported_total::text,cache_read::text,cache_write::text,cache_write_5m::text,cache_write_1h::text FROM affinity_router.usage_with_cache ORDER BY started_at DESC LIMIT 50) t`,
		"quotas":    `SELECT COALESCE(json_agg(t),'[]') FROM (SELECT * FROM affinity_router.quota_snapshots ORDER BY provider,account_id) t`,
		"decisions": `SELECT COALESCE(json_agg(t),'[]') FROM (SELECT * FROM affinity_router.routing_decisions ORDER BY id DESC LIMIT 50) t`,
		"plugins":   `SELECT COALESCE(json_agg(t),'[]') FROM (SELECT * FROM affinity_router.plugin_heartbeat ORDER BY replica_id) t`,
		"journal":   `SELECT json_build_object('admitted',count(*),'unresolved',count(*) FILTER(WHERE completed_at IS NULL),'completed',count(completed_at)) FROM affinity_router.request_journal`,
	}
	for name, query := range queries {
		var raw []byte
		if err := s.Pool.QueryRow(ctx, query).Scan(&raw); err != nil {
			return nil, err
		}
		result[name] = json.RawMessage(raw)
	}
	return result, nil
}
