// Package ingest pulls viral Instagram references from ViralEngine into a
// persona's inbox: download, normalize to h264+audio, probe, insert.
package ingest

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"time"

	"github.com/Faresapn/vireo/backend-go/internal/adapter/media"
	"github.com/Faresapn/vireo/backend-go/internal/entity"
)

// Item is one viral post from ViralEngine.
type Item struct {
	Shortcode    string   `json:"shortcode"`
	URL          string   `json:"url"`
	Views        *int64   `json:"views"`
	ViewsPerHour *float64 `json:"views_per_hour"`
	Caption      string   `json:"caption"`
	Creator      *string  `json:"creator"`
	DurationS    *float64 `json:"duration_s"`
	Duration     *float64 `json:"duration"`
}

func (it Item) seconds() float64 {
	if it.DurationS != nil && *it.DurationS != 0 {
		return *it.DurationS
	}

	if it.Duration != nil && *it.Duration != 0 {
		return *it.Duration
	}

	return 15
}

func (it Item) vph() float64 {
	if it.ViewsPerHour == nil {
		return 0
	}

	return *it.ViewsPerHour
}

// Cluster is one page of a cluster's signals.
type Cluster struct {
	Total int    `json:"total"`
	Items []Item `json:"items"`
}

// Signals lists a cluster's posts. found is false when the answer has no cluster.
type Signals interface {
	List(ctx context.Context, cluster string, order entity.IngestOrder, limit, offset int) (c Cluster, found bool, err error)
}

// Repository is the storage ingest needs.
type Repository interface {
	Persona(ctx context.Context, id string) (entity.Persona, error)
	CountVideos(ctx context.Context, personaID string) (int, error)
	OKDurationStats(ctx context.Context, niche string) (avg float64, n int, err error)
	Shortcodes(ctx context.Context, personaID string) (map[string]bool, error)
	InsertRef(ctx context.Context, r entity.NewRef) error
	ClusterPersonas(ctx context.Context) ([]entity.Persona, error)
	StaleInbox(ctx context.Context, personaID string, ttlHours int) ([]entity.Video, error)
	DeleteVideo(ctx context.Context, id int64) error
}

// Media downloads and inspects videos.
type Media interface {
	Download(ctx context.Context, url, dest string) error
	NormalizeIngest(ctx context.Context, path string) (transcoded bool, codec string, err error)
	Probe(ctx context.Context, path string) (media.Probe, error)
}

// Service ingests references.
type Service struct {
	repo        Repository
	signals     Signals
	media       Media
	personasDir string
	log         func(format string, args ...any)
}

// NewService builds a Service. log receives progress lines (stderr).
func NewService(repo Repository, signals Signals, m Media, personasDir string, log func(string, ...any)) *Service {
	return &Service{repo: repo, signals: signals, media: m, personasDir: personasDir, log: log}
}

// Options tune one ingest. Zero values mean the defaults of ingest_viral.mjs.
type Options struct {
	Limit   int                // new refs wanted, default 10
	Offset  *int               // nil = auto (past what we hold, or 0 for "date")
	Cluster string             // overrides the persona's cluster
	Order   entity.IngestOrder // velocity (default) or date
}

// Result is printed as JSON by the command.
type Result struct {
	Persona string `json:"persona"`
	Cluster string `json:"cluster"`
	Added   int    `json:"added"`
	Skipped int    `json:"skipped"`
	Failed  int    `json:"failed"`
}

// ErrNoCluster is returned when neither the persona nor the options name a cluster.
var ErrNoCluster = errors.New("persona belum punya viral_cluster_slug (dan tidak ada cluster override)")

// ErrNoClusterData is returned when ViralEngine answers without a cluster.
var ErrNoClusterData = errors.New("no cluster data")

// Ingest pulls up to opts.Limit new references into the persona's inbox.
func (s *Service) Ingest(ctx context.Context, personaID string, opts Options) (Result, error) {
	p, err := s.repo.Persona(ctx, personaID)
	if err != nil {
		return Result{}, err
	}

	slug := cmp.Or(opts.Cluster, str(p.ViralClusterSlug))
	if slug == "" {
		return Result{}, ErrNoCluster
	}

	order := entity.OrderVelocity
	if opts.Order == entity.OrderDate {
		order = entity.OrderDate
	}

	limit := cmp.Or(opts.Limit, 10)

	fetch, offset, err := s.page(ctx, personaID, order, limit, opts.Offset)
	if err != nil {
		return Result{}, err
	}

	s.log("Persona: %s | cluster: %s | order: %s | limit: %d | offset: %d", p.Name, slug, order, limit, offset)

	items, err := s.fetch(ctx, slug, order, fetch, offset)
	if err != nil {
		return Result{}, err
	}

	if order != entity.OrderDate {
		if err := s.rankByWinningDuration(ctx, p.Niche, items); err != nil {
			return Result{}, err
		}
	}

	return s.download(ctx, p.ID, slug, order, limit, items)
}

// page decides how many posts to fetch and from where. ViralEngine returns the
// same top-N by velocity every call, so velocity pages past what we already
// hold; "date" starts at the newest and fetches extra rows so `limit` new
// ones are still reachable past duplicates.
func (s *Service) page(ctx context.Context, personaID string, order entity.IngestOrder, limit int, explicit *int) (fetch, offset int, err error) {
	if explicit != nil {
		return limit, *explicit, nil
	}

	seen, err := s.repo.CountVideos(ctx, personaID)
	if err != nil {
		return 0, 0, err
	}

	if order == entity.OrderDate {
		return min(limit+seen, 50), 0, nil
	}

	return limit, seen, nil
}

// fetch lists one page, wrapping to offset 0 once if the offset ran past the end.
func (s *Service) fetch(ctx context.Context, slug string, order entity.IngestOrder, limit, offset int) ([]Item, error) {
	cl, found, err := s.signals.List(ctx, slug, order, limit, offset)
	if err != nil {
		return nil, err
	}

	if found && len(cl.Items) == 0 && offset > 0 {
		s.log("offset past end, wrapping to 0…")

		if cl, found, err = s.signals.List(ctx, slug, order, limit, 0); err != nil {
			return nil, err
		}
	}

	if !found {
		return nil, ErrNoClusterData
	}

	s.log("Got %d items from cluster (total=%d)", len(cl.Items), cl.Total)

	return cl.Items, nil
}

func str(p *string) string {
	if p == nil {
		return ""
	}

	return *p
}

// rankByWinningDuration re-ranks items when the niche has at least 3 OK
// decisions: velocity (60%) blended with closeness to the winning duration (40%).
func (s *Service) rankByWinningDuration(ctx context.Context, niche string, items []Item) error {
	avg, n, err := s.repo.OKDurationStats(ctx, niche)
	if err != nil {
		return err
	}

	if n < 3 || avg == 0 {
		return nil
	}

	s.log("RAG: niche '%s' prefers ~%.0fs refs (from %d OK). Re-ranking.", niche, avg, n)

	maxVph := 1.0
	for _, it := range items {
		maxVph = max(maxVph, it.vph())
	}

	score := func(it Item) float64 {
		pen := math.Min(math.Abs(it.seconds()-avg)/15, 1)
		return it.vph()/maxVph*0.6 + (1-pen)*0.4
	}

	slices.SortStableFunc(items, func(a, b Item) int { return cmp.Compare(score(b), score(a)) })

	return nil
}

func (s *Service) download(ctx context.Context, personaID, slug string, order entity.IngestOrder, limit int, items []Item) (Result, error) {
	res := Result{Persona: personaID, Cluster: slug}

	refsDir := filepath.Join(s.personasDir, personaID, "refs")
	if err := os.MkdirAll(refsDir, 0o750); err != nil {
		return Result{}, fmt.Errorf("creating refs dir: %w", err)
	}

	existing, err := s.repo.Shortcodes(ctx, personaID)
	if err != nil {
		return Result{}, err
	}

	for _, it := range items {
		// "date" fetched extra rows: stop at the wanted count, and don't let a
		// run of blocked posts eat the whole timeout.
		if order == entity.OrderDate && (res.Added >= limit || res.Added+res.Failed >= limit*2) {
			break
		}

		if it.Shortcode == "" || existing[it.Shortcode] {
			res.Skipped++
			continue
		}

		ok, err := s.downloadOne(ctx, personaID, slug, refsDir, order, it)
		if err != nil {
			return Result{}, err
		}

		if !ok {
			res.Failed++
			continue
		}

		existing[it.Shortcode] = true
		res.Added++
	}

	s.log("Done: +%d added, %d skipped (dup), %d failed.", res.Added, res.Skipped, res.Failed)

	return res, nil
}

// downloadOne fetches, normalizes, probes and inserts one post. ok is false
// when the download failed (the post is skipped, not fatal).
func (s *Service) downloadOne(ctx context.Context, personaID, slug, refsDir string, order entity.IngestOrder, it Item) (bool, error) {
	name := slug + "_" + it.Shortcode + ".mp4"
	dest := filepath.Join(refsDir, name)
	dctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	err := s.media.Download(dctx, it.URL, dest)

	cancel()

	if err != nil {
		s.log("  ✗ %s download gagal: %s", it.Shortcode, truncate(err.Error(), 160))
		return false, nil
	}

	if done, codec, err := s.media.NormalizeIngest(ctx, dest); err != nil {
		s.log("  ⚠ %s transcode gagal, pakai asli: %s", it.Shortcode, truncate(err.Error(), 80))
	} else if done {
		s.log("  ↻ %s transcoded %s→h264", it.Shortcode, codec)
	}

	pr, _ := s.media.Probe(ctx, dest) // a zero probe on failure, as before
	if err := s.repo.InsertRef(ctx, entity.NewRef{
		PersonaID: personaID, SourceURL: it.URL, LocalRef: filepath.Join("refs", name),
		DurationS: pr.Seconds(), Shortcode: it.Shortcode, Views: it.Views, ViewsPerHour: it.ViewsPerHour,
		Caption: truncate(it.Caption, 500), Creator: it.Creator, IngestOrder: order,
	}); err != nil {
		return false, err
	}

	v, _ := pr.Video()

	views := "null"
	if it.Views != nil {
		views = strconv.FormatInt(*it.Views, 10)
	}

	s.log("  ✓ %s %dx%d %.1fs views=%s", it.Shortcode, v.Width, v.Height, pr.Seconds(), views)

	return true, nil
}

// RefreshLine is one persona's refresh outcome.
type RefreshLine struct {
	Name    string
	Deleted int
	Added   int
	Err     error
}

// Refresh deletes inbox refs older than ttlHours (only stage 'inbox', never
// picked ones) and ingests limit fresh refs for every cluster persona.
func (s *Service) Refresh(ctx context.Context, ttlHours, limit int) ([]RefreshLine, int, error) {
	ps, err := s.repo.ClusterPersonas(ctx)
	if err != nil {
		return nil, 0, err
	}

	var lines []RefreshLine

	for _, p := range ps {
		stale, err := s.repo.StaleInbox(ctx, p.ID, ttlHours)
		if err != nil {
			return nil, 0, err
		}

		for _, v := range stale {
			if v.LocalRef != nil && *v.LocalRef != "" {
				_ = os.Remove(filepath.Join(s.personasDir, p.ID, *v.LocalRef))
			}

			if err := s.repo.DeleteVideo(ctx, v.ID); err != nil {
				return nil, 0, err
			}
		}

		ictx, cancel := context.WithTimeout(ctx, 4*time.Minute)
		r, err := s.Ingest(ictx, p.ID, Options{Limit: limit})

		cancel()

		lines = append(lines, RefreshLine{Name: p.Name, Deleted: len(stale), Added: r.Added, Err: err})
	}

	return lines, len(ps), nil
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}

	return string(r[:n])
}
