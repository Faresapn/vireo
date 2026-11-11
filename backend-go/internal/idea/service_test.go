package idea_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/Faresapn/vireo/backend-go/internal/entity"
	"github.com/Faresapn/vireo/backend-go/internal/idea"
)

func TestParseIdea(t *testing.T) {
	t.Parallel()

	sum, pr, err := idea.ParseIdea("SUMMARY: Kepin jualan es\nthinking out loud\nPROMPT:\n```\nA long enough prompt that describes the whole scene in detail.\n```")
	if err != nil || sum != "Kepin jualan es" || !strings.HasPrefix(pr, "A long enough prompt") || strings.Contains(pr, "```") {
		t.Fatalf("got %q %q %v", sum, pr, err)
	}

	if _, _, err := idea.ParseIdea("no format here"); err == nil {
		t.Fatal("want error for unformatted reply")
	}
}

func TestParseAnimals(t *testing.T) {
	t.Parallel()

	long := strings.Repeat("pink fur ", 6)

	p, err := idea.ParseAnimals("SUMMARY: Sapi pink\nMAIN: \"" + long + "\nsecond line\"\nSUB: " + long)
	if err != nil {
		t.Fatal(err)
	}

	_ = p

	if _, err := idea.ParseAnimals("SUMMARY: x\nMAIN: short\nSUB: short"); err == nil {
		t.Fatal("too-short designs must be rejected")
	}
}

type repo struct {
	master   string
	prior    []entity.IdeaVector
	inserted string
}

func (r *repo) Persona(context.Context, string) (entity.Persona, error) {
	return entity.Persona{ID: "p", Niche: "Animal", MasterPrompt: &r.master}, nil
}

func (r *repo) IdeaVectors(context.Context, string) ([]entity.IdeaVector, error) { return r.prior, nil }

func (r *repo) InsertIdea(_ context.Context, _, _, prompt, _ string, _ []float64) (int64, error) {
	r.inserted = prompt
	return 77, nil
}

type chat struct{ replies []string }

func (c *chat) Chat(context.Context, string, string, int) (string, error) {
	r := c.replies[0]
	if len(c.replies) > 1 {
		c.replies = c.replies[1:]
	}

	return r, nil
}

// embedder returns the prior vector for the first n calls (a duplicate), then a new one.
type embedder struct{ dupes int }

func (e *embedder) Embed(context.Context, string) ([]float64, error) {
	if e.dupes > 0 {
		e.dupes--
		return []float64{1, 0}, nil
	}

	return []float64{0, 1}, nil
}

func TestSlotTemplateFillsAndRetriesDuplicates(t *testing.T) {
	t.Parallel()

	long := strings.Repeat("blue fur ", 6)
	r := &repo{
		master: "AUTO_DURATION: 14\nGUIDE\n" + idea.PromptMarker + "\nMAIN={{MAIN_ANIMAL}} SUB={{SUB_ANIMAL}}",
		prior:  []entity.IdeaVector{{Summary: "old", Vector: []float64{1, 0}}},
	}
	c := &chat{replies: []string{"SUMMARY: dup\nMAIN: " + long + "\nSUB: " + long, "SUMMARY: new\nMAIN: BIG " + long + "\nSUB: SMALL " + long}}
	svc := idea.NewService(r, c, &embedder{dupes: 1}, func(string, ...any) {}, func() time.Time { return time.UnixMilli(0) })

	res, err := svc.Generate(context.Background(), "p")
	if err != nil {
		t.Fatal(err)
	}

	if res.Summary != "new" || res.Sim != 0 || res.VideoID != 77 {
		t.Fatalf("result %+v", res)
	}

	if !strings.HasPrefix(r.inserted, "MAIN=BIG ") || strings.Contains(r.inserted, "{{") {
		t.Fatalf("template not filled: %q", r.inserted)
	}
}

func TestAllAttemptsFail(t *testing.T) {
	t.Parallel()

	r := &repo{master: "free master"}

	svc := idea.NewService(r, &chat{replies: []string{"garbage"}}, &embedder{}, func(string, ...any) {}, nil)
	if _, err := svc.Generate(context.Background(), "p"); !errors.Is(err, idea.ErrExhausted) {
		t.Fatalf("err = %v", err)
	}
}

func TestAvoidClause(t *testing.T) {
	t.Parallel()

	if !strings.Contains(idea.AvoidClause(nil), "first") {
		t.Fatal("empty avoid list")
	}

	if got := idea.AvoidClause([]string{"a", "b"}); !strings.HasSuffix(got, "1. a\n2. b\n") {
		t.Fatalf("got %q", got)
	}
}
