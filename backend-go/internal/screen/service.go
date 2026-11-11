// Package screen rates how well a reference video suits character motion
// transfer, using the vision LLM on three frames, and stores the score.
package screen

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"

	"github.com/Faresapn/vireo/backend-go/internal/adapter/llm"
	"github.com/Faresapn/vireo/backend-go/internal/entity"
)

var (
	//go:embed prompts/system.txt
	systemPrompt string
	//go:embed prompts/wan_rules.txt
	wanRules string
)

// MaxRefSeconds is the longest reference any engine accepts.
const MaxRefSeconds = 30

// Result is the verdict, printed as JSON.
type Result struct {
	Score   float64 `json:"score"`
	Verdict string  `json:"verdict"`
	Reason  string  `json:"reason"`
}

// Repository is the storage screening needs.
type Repository interface {
	Persona(ctx context.Context, id string) (entity.Persona, error)
	Video(ctx context.Context, personaID string, videoID int64) (entity.Video, error)
	SaveScreen(ctx context.Context, videoID int64, score int, notes string) error
}

// Media reads duration and frames.
type Media interface {
	Duration(ctx context.Context, path string) (float64, error)
	Frames(ctx context.Context, path string, fractions []float64, width int, fallbackDur float64) ([][]byte, error)
}

// Vision is the multimodal LLM.
type Vision interface {
	ChatParts(ctx context.Context, system string, parts []llm.Part, maxTokens int) (string, error)
}

// Service screens references.
type Service struct {
	repo        Repository
	media       Media
	vision      Vision
	personasDir string
}

// NewService builds a Service.
func NewService(repo Repository, m Media, v Vision, personasDir string) *Service {
	return &Service{repo: repo, media: m, vision: v, personasDir: personasDir}
}

// ErrRefMissing is returned when the reference file is not on disk.
var ErrRefMissing = errors.New("ref missing")

// Screen scores one reference and saves the score.
func (s *Service) Screen(ctx context.Context, personaID string, videoID int64) (Result, error) {
	v, err := s.repo.Video(ctx, personaID, videoID)
	if err != nil {
		return Result{}, err
	}

	if v.LocalRef == nil {
		return Result{}, ErrRefMissing
	}

	ref := filepath.Join(s.personasDir, personaID, *v.LocalRef)
	if _, err := os.Stat(ref); err != nil {
		return Result{}, ErrRefMissing
	}

	// Hard gate before spending a vision call: no engine takes >30s refs.
	if dur, _ := s.media.Duration(ctx, ref); dur > MaxRefSeconds {
		res := Result{Score: 0, Verdict: "bad", Reason: fmt.Sprintf("Too long (%.0fs > 30s engine limit)", dur)}
		return res, s.save(ctx, videoID, res)
	}

	p, err := s.repo.Persona(ctx, personaID)
	if err != nil {
		return Result{}, err
	}

	frames, err := s.media.Frames(ctx, ref, []float64{0.1, 0.5, 0.9}, 480, 10)
	if err != nil {
		return Result{}, err
	}

	extra := ""
	if p.AutoEngine != nil && strings.HasPrefix(*p.AutoEngine, "wan") {
		extra = wanRules
	}

	parts := []llm.Part{llm.Text("Rate this reference (3 frames: start/mid/end):")}
	for _, f := range frames {
		parts = append(parts, llm.JPEG(f))
	}

	reply, err := s.vision.ChatParts(ctx, strings.ReplaceAll(systemPrompt, "{{EXTRA_RULES}}", extra), parts, 200)
	if err != nil {
		return Result{}, err
	}

	var res Result
	if err := llm.ExtractJSON(reply, &res); err != nil {
		return Result{}, err
	}

	return res, s.save(ctx, videoID, res)
}

func (s *Service) save(ctx context.Context, videoID int64, r Result) error {
	return s.repo.SaveScreen(ctx, videoID, int(math.Round(r.Score)), r.Verdict+": "+r.Reason)
}
