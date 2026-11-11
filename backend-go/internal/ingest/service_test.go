package ingest_test

import (
	"context"
	"errors"
	"testing"

	"github.com/Faresapn/vireo/backend-go/internal/adapter/media"
	"github.com/Faresapn/vireo/backend-go/internal/entity"
	"github.com/Faresapn/vireo/backend-go/internal/ingest"
)

type repo struct {
	known    map[string]bool
	count    int
	avg      float64
	okN      int
	inserted []entity.NewRef
}

func (r *repo) Persona(context.Context, string) (entity.Persona, error) {
	c := "anatoly"
	return entity.Persona{ID: "p", Name: "P", Niche: "n", ViralClusterSlug: &c}, nil
}
func (r *repo) CountVideos(context.Context, string) (int, error) { return r.count, nil }
func (r *repo) OKDurationStats(context.Context, string) (float64, int, error) {
	return r.avg, r.okN, nil
}
func (r *repo) Shortcodes(context.Context, string) (map[string]bool, error) { return r.known, nil }
func (r *repo) InsertRef(_ context.Context, ref entity.NewRef) error {
	r.inserted = append(r.inserted, ref)
	return nil
}
func (r *repo) ClusterPersonas(context.Context) ([]entity.Persona, error) { return nil, nil }
func (r *repo) StaleInbox(context.Context, string, int) ([]entity.Video, error) {
	return nil, nil
}
func (r *repo) DeleteVideo(context.Context, int64) error { return nil }

type signals struct {
	calls  []int // offsets asked
	limits []int
	pages  map[int][]ingest.Item
}

func (s *signals) List(_ context.Context, _ string, _ entity.IngestOrder, limit, offset int) (ingest.Cluster, bool, error) {
	s.calls, s.limits = append(s.calls, offset), append(s.limits, limit)
	return ingest.Cluster{Items: s.pages[offset]}, true, nil
}

type fakeMedia struct{ fail map[string]bool }

func (m fakeMedia) Download(_ context.Context, url, _ string) error {
	if m.fail[url] {
		return errors.New("ERROR: private")
	}

	return nil
}

func (fakeMedia) NormalizeIngest(context.Context, string) (bool, string, error) {
	return false, "h264", nil
}
func (fakeMedia) Probe(context.Context, string) (media.Probe, error) { return media.Probe{}, nil }

func item(code string, vph, dur float64) ingest.Item {
	return ingest.Item{Shortcode: code, URL: "u/" + code, ViewsPerHour: &vph, DurationS: &dur}
}

func quiet(string, ...any) {}

func TestVelocityPagesPastKnownRefsAndWraps(t *testing.T) {
	t.Parallel()

	r := &repo{known: map[string]bool{"a": true}, count: 5}
	s := &signals{pages: map[int][]ingest.Item{0: {item("a", 1, 10), item("b", 1, 10)}}}

	res, err := ingest.NewService(r, s, fakeMedia{}, t.TempDir(), quiet).Ingest(context.Background(), "p", ingest.Options{Limit: 2})
	if err != nil {
		t.Fatal(err)
	}

	if len(s.calls) != 2 || s.calls[0] != 5 || s.calls[1] != 0 {
		t.Fatalf("offsets %v: want 5 (past held refs) then a wrap to 0", s.calls)
	}

	if res.Added != 1 || res.Skipped != 1 || r.inserted[0].LocalRef != "refs/anatoly_b.mp4" {
		t.Fatalf("res %+v inserted %+v", res, r.inserted)
	}
}

func TestDateOrderStopsAtLimitAndCountsFailures(t *testing.T) {
	t.Parallel()

	r := &repo{known: map[string]bool{}, count: 3}
	s := &signals{pages: map[int][]ingest.Item{0: {item("x", 1, 1), item("y", 1, 1), item("z", 1, 1)}}}
	m := fakeMedia{fail: map[string]bool{"u/x": true}}

	res, err := ingest.NewService(r, s, m, t.TempDir(), quiet).Ingest(context.Background(), "p", ingest.Options{Limit: 1, Order: entity.OrderDate})
	if err != nil {
		t.Fatal(err)
	}

	if s.calls[0] != 0 || s.limits[0] != 4 {
		t.Fatalf("date order must start at 0 and fetch limit+held: offset %d limit %d", s.calls[0], s.limits[0])
	}

	if res.Added != 1 || res.Failed != 1 || r.inserted[0].Shortcode != "y" || r.inserted[0].IngestOrder != entity.OrderDate {
		t.Fatalf("res %+v inserted %+v", res, r.inserted)
	}
}

func TestRankByWinningDuration(t *testing.T) {
	t.Parallel()

	r := &repo{known: map[string]bool{}, avg: 10, okN: 3}

	s := &signals{pages: map[int][]ingest.Item{0: {item("fast-long", 100, 60), item("slow-fit", 80, 10)}}}
	if _, err := ingest.NewService(r, s, fakeMedia{}, t.TempDir(), quiet).Ingest(context.Background(), "p", ingest.Options{Limit: 1, Offset: new(0)}); err != nil {
		t.Fatal(err)
	}

	if r.inserted[0].Shortcode != "slow-fit" {
		t.Fatalf("first ingested %q: duration fit should outrank raw velocity", r.inserted[0].Shortcode)
	}
}
