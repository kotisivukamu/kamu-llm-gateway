package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// GET /usage exposes this machine's SQLite usage_log so the control plane
// (the api's poller) can pull completed-request rows into Postgres, and so a
// key holder can read its own usage. Every proxy machine has its own file on
// its own volume; rows carry a usage_id (UUIDv7, unique across machines,
// time-ordered) and the machine_id that served them.
//
// Two readers, two views:
//   - The poller (CONTROL_PLANE_POLL_TOKEN) reads ONE machine: it polls every
//     machine itself (vms.<app>.internal) and asks each for rows `after` the
//     newest usage_id it has. This path never fans out.
//   - A key holder reads through whichever machine Fly routes it to, but its
//     calls may have been served by any machine. That machine answers from its
//     own file and asks every sibling over 6PN (GET /usage/local), then
//     merges. A sibling that does not answer within 2 s is left out, logged,
//     and named in the X-Usage-Partial response header.
//
// CONTRACT, shared with the api's poller (api/src/lib/usage-poller.ts):
//
//	GET /usage?since=<id>&after=<usage_id>&limit=<n>&key_id=<id>&jti=<id>&name=<label>
//	Auth: Authorization: Bearer <CONTROL_PLANE_POLL_TOKEN>: every row of THIS
//	      machine.
//	  OR  a gateway credential (x-api-key or Authorization: Bearer), verified
//	      like the /llm routes: a top-level key sees rows whose root_key_id is
//	      its id (its own and every derived key's), a derived key only its
//	      own; on EVERY machine. Filters only narrow this scope. Cost readers
//	      use the api's GET /usage (ingest-priced, ADR 0003 §5); cost_usd here
//	      is the catalog estimate.
//	200: { rows: [usageRow...], max_id: number|null, totals: {...} }
//	     totals are summed over the returned rows only; totals.cost_usd sums
//	     the non-null cost_usd.
//
// `id` and `since`:
//   - poll token: `id` is this machine's SQLite row id. `after` returns rows
//     with usage_id > after, ordered by usage_id; without it rows come ordered
//     by id from `since`.
//   - key holder: a row id only means something on one machine, so `id` is a
//     number derived from usage_id (cursorOf: ms since 2026-01-01 * 4096 + the
//     UUIDv7 counter). It orders rows by time across machines; clients pass
//     max_id back as `since`. Rows without a usage_id are not in this view. A
//     page stops at the lowest point every answering machine has fully
//     written (Ledger.usageFloor), so a later read never finds a row below a
//     cursor it already handed out.
//
// `since` defaults to 0. `limit` defaults to 5000, capped at 5000; a merged
// page can exceed it by rows that share the last row's id (one per machine at
// most), so the next `since` never splits them. key_id, jti (the same column)
// and name are equality filters.
//
//	GET /usage/local: sibling-to-sibling only, poll token auth. The key-holder
//	params plus the caller's scope (scope_root=<id> or scope_key=<id>);
//	answers from this machine only with { rows, floor }, floor being this
//	machine's usageFloor as a cursor.

const (
	maxUsageLimit   = 5000
	siblingTimeout  = 2 * time.Second
	cursorEpochMs   = 1767225600000 // 2026-01-01T00:00:00Z
	cursorPerMs     = 4096
	siblingDNSLabel = "vms.%s.internal"
)

type usageRow struct {
	ID               int64    `json:"id"`
	UsageID          *string  `json:"usage_id"`
	MachineID        *string  `json:"machine_id"`
	KeyID            string   `json:"key_id"`
	JTI              string   `json:"jti"`
	Name             string   `json:"name"`
	ParentKeyID      *string  `json:"parent_key_id"`
	RootKeyID        *string  `json:"root_key_id"`
	Model            string   `json:"model"`
	ProviderSlug     *string  `json:"provider_slug"`
	InputTokens      float64  `json:"input_tokens"`
	OutputTokens     float64  `json:"output_tokens"`
	CacheReadTokens  float64  `json:"cache_read_tokens"`
	CacheWriteTokens float64  `json:"cache_write_tokens"`
	ProviderCost     *float64 `json:"provider_cost"`
	CostUsd          *float64 `json:"cost_usd"`
	CreatedAt        string   `json:"created_at"`
}

type usageTotals struct {
	Requests         int     `json:"requests"`
	InputTokens      float64 `json:"input_tokens"`
	OutputTokens     float64 `json:"output_tokens"`
	CacheReadTokens  float64 `json:"cache_read_tokens"`
	CacheWriteTokens float64 `json:"cache_write_tokens"`
	CostUsd          float64 `json:"cost_usd"`
}

type usagePage struct {
	Rows   []usageRow  `json:"rows"`
	MaxID  *int64      `json:"max_id"`
	Totals usageTotals `json:"totals"`
}

// What GET /usage/local answers with.
type localPage struct {
	Rows  []usageRow `json:"rows"`
	Floor int64      `json:"floor"`
}

// cursorOf is the cross-machine cursor of a UUIDv7: ms since 2026-01-01,
// times 4096, plus the 12-bit counter.
func cursorOf(usageID string) int64 {
	h := strings.ReplaceAll(usageID, "-", "")
	ms, _ := strconv.ParseInt(h[0:12], 16, 64)
	counter, _ := strconv.ParseInt(h[13:16], 16, 64)
	return (ms-cursorEpochMs)*cursorPerMs + counter
}

// usageIDAtLeast is the smallest usage_id string whose cursor is >= cursor:
// the timestamp and version+counter groups. Any id with a larger cursor sorts
// after it as a string, any id with a smaller one before.
func usageIDAtLeast(cursor int64) string {
	ms := cursor/cursorPerMs + cursorEpochMs
	counter := cursor % cursorPerMs
	h := fmt.Sprintf("%012x", ms)
	return fmt.Sprintf("%s-%s-7%03x", h[0:8], h[8:], counter)
}

// intParam is the numeric query param, or fallback when absent, not a
// number, or 0 (the JS `Number(x) || fallback`).
func intParam(q url.Values, name string, fallback int64) int64 {
	f, err := strconv.ParseFloat(q.Get(name), 64)
	if err != nil || f == 0 || math.IsNaN(f) {
		return fallback
	}
	return int64(f)
}

func limitOf(q url.Values) int64 {
	return min(maxUsageLimit, max(1, intParam(q, "limit", maxUsageLimit)))
}

// addFilters appends the key_id/jti/name equality filters.
func addFilters(q url.Values, conds []string, args []any) ([]string, []any) {
	for _, p := range []string{"key_id", "jti"} { // the same column
		if v := q.Get(p); v != "" {
			conds = append(conds, "key_id = ?")
			args = append(args, v)
		}
	}
	if v := q.Get("name"); v != "" {
		conds = append(conds, "name = ?")
		args = append(args, v)
	}
	return conds, args
}

func (l *Ledger) selectRows(conds []string, args []any, orderBy string, limit int64) ([]usageRow, error) {
	db, err := l.conn()
	if err != nil {
		return nil, err
	}
	rows, err := db.Query(`SELECT id, usage_id, machine_id, key_id, jti, name, parent_key_id, root_key_id, model,
	        provider_slug, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
	        provider_cost, cost_usd, created_at
	   FROM usage_log
	  WHERE `+strings.Join(conds, " AND ")+`
	  ORDER BY `+orderBy+` ASC
	  LIMIT ?`, append(args, limit)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []usageRow{}
	for rows.Next() {
		var r usageRow
		if err := rows.Scan(&r.ID, &r.UsageID, &r.MachineID, &r.KeyID, &r.JTI, &r.Name,
			&r.ParentKeyID, &r.RootKeyID, &r.Model, &r.ProviderSlug,
			&r.InputTokens, &r.OutputTokens, &r.CacheReadTokens, &r.CacheWriteTokens,
			&r.ProviderCost, &r.CostUsd, &r.CreatedAt); err != nil {
			return nil, err
		}
		// datetime('now') is "YYYY-MM-DD HH:MM:SS" in UTC: emit ISO 8601 with a
		// Z so the control plane stores a real timestamptz.
		r.CreatedAt = strings.Replace(r.CreatedAt, " ", "T", 1) + "Z"
		out = append(out, r)
	}
	return out, rows.Err()
}

// page adds max_id and totals, summed over these rows only, so the two never
// drift from what the caller sees.
func page(rows []usageRow) usagePage {
	p := usagePage{Rows: rows}
	for _, r := range rows {
		p.Totals.Requests++
		p.Totals.InputTokens += r.InputTokens
		p.Totals.OutputTokens += r.OutputTokens
		p.Totals.CacheReadTokens += r.CacheReadTokens
		p.Totals.CacheWriteTokens += r.CacheWriteTokens
		if r.CostUsd != nil {
			p.Totals.CostUsd += *r.CostUsd
		}
	}
	if len(rows) > 0 {
		id := rows[len(rows)-1].ID
		p.MaxID = &id
	}
	return p
}

// usageScope is what a key holder may read: a top-level key's whole tree
// (root_key_id = its id, set at mint) or a derived key itself (depth 1).
type usageScope struct {
	root string
	key  string
}

// localPage is this machine's share of a key-holder read, with `id` as the
// cross-machine cursor. The floor is taken first: every row under it is
// already written.
func (a *app) localPage(scope usageScope, q url.Values) (localPage, error) {
	fms, fseq := a.ledger.usageFloor(time.Now().UnixMilli())
	floor := (fms-cursorEpochMs)*cursorPerMs + int64(fseq)
	since := max(0, intParam(q, "since", 0))
	conds := []string{"usage_id >= ?"}
	args := []any{usageIDAtLeast(since + 1)}
	if scope.root != "" {
		conds = append(conds, "root_key_id = ?")
		args = append(args, scope.root)
	} else {
		conds = append(conds, "key_id = ?")
		args = append(args, scope.key)
	}
	// `after` is the poller's cursor, but narrowing by it is harmless here.
	if after := q.Get("after"); after != "" {
		conds = append(conds, "usage_id > ?")
		args = append(args, after)
	}
	conds, args = addFilters(q, conds, args)
	rows, err := a.ledger.selectRows(conds, args, "usage_id", limitOf(q))
	if err != nil {
		return localPage{}, err
	}
	for i := range rows {
		rows[i].ID = cursorOf(*rows[i].UsageID)
	}
	return localPage{Rows: rows, Floor: floor}, nil
}

// discoverSiblings lists the other machines of this Fly app as 6PN origins,
// from the vms.<app>.internal TXT record ("<id> <region>" pairs, comma
// separated, the same record the api poller reads). None outside Fly.
func (a *app) discoverSiblings(ctx context.Context) ([]string, error) {
	if a.cfg.AppName == "" {
		return nil, nil
	}
	records, err := net.DefaultResolver.LookupTXT(ctx, fmt.Sprintf(siblingDNSLabel, a.cfg.AppName))
	if err != nil {
		return nil, err
	}
	var out []string
	for _, e := range strings.Split(strings.Join(records, ","), ",") {
		id, _, _ := strings.Cut(strings.TrimSpace(e), " ")
		if id == "" || id == a.cfg.MachineID {
			continue
		}
		out = append(out, fmt.Sprintf("http://%s.vm.%s.internal:%s", id, a.cfg.AppName, a.cfg.Port))
	}
	return out, nil
}

func (a *app) fetchSibling(ctx context.Context, origin string, query url.Values) (localPage, error) {
	ctx, cancel := context.WithTimeout(ctx, siblingTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, origin+"/usage/local?"+query.Encode(), nil)
	if err != nil {
		return localPage{}, err
	}
	req.Header.Set("Authorization", "Bearer "+a.cfg.PollToken)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return localPage{}, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return localPage{}, fmt.Errorf("status %d", res.StatusCode)
	}
	var p localPage
	err = json.NewDecoder(res.Body).Decode(&p)
	return p, err
}

// mergedPage is a key holder's read across all machines. missing names the
// machines that did not answer.
func (a *app) mergedPage(ctx context.Context, scope usageScope, q url.Values) (usagePage, []string, error) {
	query := url.Values{}
	for k, v := range q {
		query[k] = v
	}
	query.Del("scope_root")
	query.Del("scope_key")
	if scope.root != "" {
		query.Set("scope_root", scope.root)
	} else {
		query.Set("scope_key", scope.key)
	}

	local, err := a.localPage(scope, q)
	if err != nil {
		return usagePage{}, nil, err
	}
	answers := []localPage{local}
	var missing []string
	origins, err := a.siblings(ctx)
	if err != nil {
		log.Printf("[usage] sibling discovery failed: %v", err)
		missing = append(missing, "discovery")
	}
	results := make([]localPage, len(origins))
	errs := make([]error, len(origins))
	var wg sync.WaitGroup
	for i, o := range origins {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i], errs[i] = a.fetchSibling(ctx, o, query)
		}()
	}
	wg.Wait()
	for i, o := range origins {
		if errs[i] != nil {
			log.Printf("[usage] sibling %s unavailable: %v", o, errs[i])
			u, _ := url.Parse(o)
			host, _, _ := strings.Cut(u.Hostname(), ".")
			missing = append(missing, host)
			continue
		}
		answers = append(answers, results[i])
	}

	// Only rows under every answering machine's floor: above it a machine may
	// still write a row that sorts before ones handed out now. A row reported
	// twice counts once (first copy wins; this machine's comes first).
	floor := answers[0].Floor
	for _, ans := range answers[1:] {
		floor = min(floor, ans.Floor)
	}
	seen := map[string]bool{}
	rows := []usageRow{}
	for _, ans := range answers {
		for _, r := range ans.Rows {
			if r.ID < floor && !seen[*r.UsageID] {
				seen[*r.UsageID] = true
				rows = append(rows, r)
			}
		}
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].ID != rows[j].ID {
			return rows[i].ID < rows[j].ID
		}
		return *rows[i].UsageID < *rows[j].UsageID
	})

	// Each machine sent at most `limit` rows, so the first `limit` merged rows
	// are complete. Rows sharing the last one's id stay in: a next page from
	// `since` = that id would skip them.
	end := min(int(limitOf(q)), len(rows))
	for end < len(rows) && rows[end].ID == rows[end-1].ID {
		end++
	}
	return page(rows[:end]), missing, nil
}

func bearer(r *http.Request) string {
	return strings.TrimSpace(bearerPrefix.ReplaceAllString(r.Header.Get("Authorization"), ""))
}

// usageLocal serves GET /usage/local.
func (a *app) usageLocal(w http.ResponseWriter, r *http.Request) error {
	if bearer(r) != a.cfg.PollToken {
		writeJSON(w, 401, obj("error", "unauthorized"))
		return nil
	}
	q := r.URL.Query()
	root, key := q.Get("scope_root"), q.Get("scope_key")
	if (root == "") == (key == "") {
		writeJSON(w, 400, obj("error", "exactly one of scope_root, scope_key"))
		return nil
	}
	p, err := a.localPage(usageScope{root: root, key: key}, q)
	if err != nil {
		return err
	}
	writeJSON(w, 200, p)
	return nil
}

// usage serves /usage (any method, as before). The poller presents the
// service secret and sees everything on this machine; a key holder presents
// its own credential and sees only its own subtree (top-level key) or itself
// (derived key), on every machine. The data is not secret (labels, token
// counts, estimated cost, no payloads), but it does not go out
// unauthenticated.
func (a *app) usage(w http.ResponseWriter, r *http.Request) error {
	q := r.URL.Query()
	if presented := bearer(r); presented == "" || presented != a.cfg.PollToken {
		cred, err := a.auth.verify(r.Context(), extractCredential(r.Header))
		if err != nil {
			return err
		}
		if cred == nil {
			writeJSON(w, 401, obj("error", "unauthorized"))
			return nil
		}
		scope := usageScope{key: cred.KeyID}
		if cred.KeyType == "top" {
			scope = usageScope{root: cred.KeyID}
		}
		body, missing, err := a.mergedPage(r.Context(), scope, q)
		if err != nil {
			return err
		}
		if len(missing) > 0 {
			w.Header().Set("X-Usage-Partial", strings.Join(missing, ","))
		}
		writeJSON(w, 200, body)
		return nil
	}

	// The poller pages by usage_id; without `after`, by this machine's row id.
	after := q.Get("after")
	conds, args, order := []string{"id > ?"}, []any{max(0, intParam(q, "since", 0))}, "id"
	if after != "" {
		conds, args, order = []string{"usage_id > ?"}, []any{after}, "usage_id"
	}
	conds, args = addFilters(q, conds, args)
	rows, err := a.ledger.selectRows(conds, args, order, limitOf(q))
	if err != nil {
		return err
	}
	writeJSON(w, 200, page(rows))
	return nil
}
