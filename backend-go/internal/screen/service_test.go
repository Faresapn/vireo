package screen_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Faresapn/vireo/backend-go/internal/adapter/llm"
	"github.com/Faresapn/vireo/backend-go/internal/entity"
	"github.com/Faresapn/vireo/backend-go/internal/screen"
)

type repo struct {
	engine string
	score  int
	notes  string
}

func (r *repo) Persona(context.Context, string) (entity.Persona, error) {
	return entity.Persona{ID: "p", AutoEngine: &r.engine}, nil
}

func (r *repo) Video(context.Context, string, int64) (entity.Video, error) {
	ref := "r.mp4"
	return entity.Video{ID: 1, LocalRef: &ref}, nil
}

func (r *repo) SaveScreen(_ context.Context, _ int64, score int, notes string) error {
	r.score, r.notes = score, notes
	return nil
}

type media struct{ dur float64 }

func (m media) Duration(context.Context, string) (float64, error) { return m.dur, nil }
func (media) Frames(context.Context, string, []float64, int, float64) ([][]byte, error) {
	return [][]byte{{1}, {2}, {3}}, nil
}

type vision struct {
	calls  int
	system string
	parts  int
}

func (v *vision) ChatParts(_ context.Context, sys string, parts []llm.Part, _ int) (string, error) {
	v.calls++
	v.system, v.parts = sys, len(parts)

	return "Here you go: {\"score\": 72, \"verdict\": \"good\", \"reason\": \"clear subject\"}", nil
}

func dir(t *testing.T) string {
	t.Helper()

	d := t.TempDir()
	if err := os.MkdirAll(filepath.Join(d, "p"), 0o750); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(filepath.Join(d, "p", "r.mp4"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	return d
}

func TestScreenScoresAndAddsWanRules(t *testing.T) {
	t.Parallel()

	r, v := &repo{engine: "wan-prime"}, &vision{}

	res, err := screen.NewService(r, media{dur: 12}, v, dir(t)).Screen(context.Background(), "p", 1)
	if err != nil {
		t.Fatal(err)
	}

	if res.Score != 72 || r.score != 72 || r.notes != "good: clear subject" {
		t.Fatalf("res %+v saved %d %q", res, r.score, r.notes)
	}

	if v.parts != 4 || !strings.Contains(v.system, "Wan 3.0 Prime") || strings.Contains(v.system, "{{") {
		t.Fatalf("parts %d, wan rules missing or placeholder left", v.parts)
	}
}

func TestTooLongRefSkipsVision(t *testing.T) {
	t.Parallel()

	r, v := &repo{engine: "seedance"}, &vision{}

	res, err := screen.NewService(r, media{dur: 45}, v, dir(t)).Screen(context.Background(), "p", 1)
	if err != nil {
		t.Fatal(err)
	}

	if v.calls != 0 || res.Score != 0 || r.notes != "bad: Too long (45s > 30s engine limit)" {
		t.Fatalf("vision calls %d, res %+v, notes %q", v.calls, res, r.notes)
	}
}
