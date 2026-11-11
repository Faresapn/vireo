// Package idea invents a fresh video idea for an idea-only persona (no viral
// cluster) from its master prompt, rejects near-duplicates of the persona's
// past ideas by embedding similarity, and saves it as a shortlist draft.
package idea

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Faresapn/vireo/backend-go/internal/adapter/embedding"
	"github.com/Faresapn/vireo/backend-go/internal/entity"
)

var (
	//go:embed prompts/idea_system.txt
	ideaSystem string
	//go:embed prompts/idea_user.txt
	ideaUser string
	//go:embed prompts/animals_system.txt
	animalsSystem string
	//go:embed prompts/animals_user.txt
	animalsUser string
)

// Tuning from generate_idea.mjs.
const (
	SimThreshold = 0.93 // cosine >= this vs any past idea = too similar
	MaxTries     = 4
	avoidCap     = 40 // past summaries sent to the LLM (dedup still checks all)
	callTimeout  = 55 * time.Second
	// PromptMarker separates a slot-template master's guide from its template.
	PromptMarker = "=== PROMPT SIAP KIRIM ==="
)

// Repository is the storage idea generation needs.
type Repository interface {
	Persona(ctx context.Context, id string) (entity.Persona, error)
	IdeaVectors(ctx context.Context, personaID string) ([]entity.IdeaVector, error)
	InsertIdea(ctx context.Context, personaID, shortcode, prompt, summary string, vector []float64) (int64, error)
}

// Chat is the text LLM.
type Chat interface {
	Chat(ctx context.Context, system, user string, maxTokens int) (string, error)
}

// Embedder turns text into a vector.
type Embedder interface {
	Embed(ctx context.Context, text string) ([]float64, error)
}

// Service generates ideas.
type Service struct {
	repo  Repository
	llm   Chat
	embed Embedder
	log   func(string, ...any)
	now   func() time.Time
}

// NewService builds a Service.
func NewService(repo Repository, c Chat, e Embedder, log func(string, ...any), now func() time.Time) *Service {
	if now == nil {
		now = time.Now
	}

	return &Service{repo: repo, llm: c, embed: e, log: log, now: now}
}

// Result is printed as JSON.
type Result struct {
	OK      bool    `json:"ok"`
	VideoID int64   `json:"video_id"`
	Summary string  `json:"summary"`
	Prompt  string  `json:"prompt"`
	Sim     float64 `json:"sim"`
}

// Errors returned by Generate.
var (
	ErrNoMaster  = errors.New("persona has no master_prompt — isi master prompt dulu")
	ErrNoMarker  = errors.New(`master prompt punya {{MAIN_ANIMAL}} tapi tidak ada baris "` + PromptMarker + `"`)
	ErrExhausted = fmt.Errorf("could not produce any idea after %d tries", MaxTries)
)

type candidate struct {
	summary, prompt string
	embedText       string
}

// Generate creates one new idea draft.
func (s *Service) Generate(ctx context.Context, personaID string) (Result, error) {
	p, err := s.repo.Persona(ctx, personaID)
	if err != nil {
		return Result{}, err
	}

	master := ""
	if p.MasterPrompt != nil {
		master = strings.TrimSpace(*p.MasterPrompt)
	}

	if master == "" {
		return Result{}, ErrNoMaster
	}

	prior, err := s.repo.IdeaVectors(ctx, personaID)
	if err != nil {
		return Result{}, err
	}

	avoid := make([]string, 0, min(len(prior), avoidCap))
	for _, iv := range prior[:min(len(prior), avoidCap)] {
		avoid = append(avoid, iv.Summary)
	}

	var gen func(avoid []string) (candidate, error)

	if strings.Contains(master, "{{MAIN_ANIMAL}}") {
		at := strings.LastIndex(master, PromptMarker)
		if at < 0 {
			return Result{}, ErrNoMarker
		}

		guide := strings.TrimSpace(autoDurationLine.ReplaceAllString(master[:at], ""))
		tmpl := strings.TrimSpace(master[at+len(PromptMarker):])
		gen = func(avoid []string) (candidate, error) {
			pair, err := s.animals(ctx, guide, p.Niche, avoid)
			if err != nil {
				return candidate{}, err
			}

			s.log("[slot-template] MAIN: %s… | SUB: %s…", truncate(pair.Main, 80), truncate(pair.Sub, 80))

			return candidate{
				summary:   pair.Summary,
				prompt:    strings.NewReplacer("{{MAIN_ANIMAL}}", pair.Main, "{{SUB_ANIMAL}}", pair.Sub).Replace(tmpl),
				embedText: pair.Summary + "\nMAIN: " + pair.Main + "\nSUB: " + pair.Sub,
			}, nil
		}
	} else {
		gen = func(avoid []string) (candidate, error) {
			sum, pr, err := s.freeIdea(ctx, master, p.Niche, avoid)
			return candidate{summary: sum, prompt: pr, embedText: sum + "\n" + pr}, err
		}
	}

	best, vec, sim, err := s.novel(ctx, gen, prior, avoid)
	if err != nil {
		return Result{}, err
	}

	shortcode := "idea" + strconv.FormatInt(s.now().UnixMilli(), 36)

	id, err := s.repo.InsertIdea(ctx, personaID, shortcode, best.prompt, best.summary, vec)
	if err != nil {
		return Result{}, err
	}

	return Result{OK: true, VideoID: id, Summary: best.summary, Prompt: best.prompt, Sim: roundTo(sim, 4)}, nil
}

var autoDurationLine = regexp.MustCompile(`(?m)^AUTO_DURATION:.*$`)

// novel tries up to MaxTries ideas until one is below SimThreshold against
// every past vector; otherwise it keeps the least similar attempt.
func (s *Service) novel(ctx context.Context, gen func([]string) (candidate, error), prior []entity.IdeaVector, avoid []string) (candidate, []float64, float64, error) {
	var (
		best    candidate
		bestVec []float64
		bestSim = -1.0
	)

	for attempt := 1; attempt <= MaxTries; attempt++ {
		s.log("idea attempt %d/%d…", attempt, MaxTries)

		c, err := gen(avoid)
		if err != nil {
			s.log("  attempt %d failed: %s", attempt, truncate(err.Error(), 80))
			continue
		}

		vec, err := s.embed.Embed(ctx, c.embedText)
		if err != nil {
			return candidate{}, nil, 0, err
		}

		maxSim := 0.0

		for _, pv := range prior {
			if len(pv.Vector) > 0 {
				maxSim = max(maxSim, embedding.Cosine(vec, pv.Vector))
			}
		}

		s.log("  max cosine vs %d prior: %.4f", len(prior), maxSim)

		if bestSim < 0 || maxSim < bestSim {
			best, bestVec, bestSim = c, vec, maxSim
		}

		if maxSim < SimThreshold {
			return c, vec, maxSim, nil
		}

		avoid = append([]string{c.summary}, avoid...) // steer the next try away
	}

	if bestSim < 0 {
		return candidate{}, nil, 0, ErrExhausted
	}

	s.log("no attempt under %.2f; using least-similar (sim %.4f)", SimThreshold, bestSim)

	return best, bestVec, bestSim, nil
}

// AvoidClause lists past ideas the LLM must not repeat.
func AvoidClause(avoid []string) string {
	if len(avoid) == 0 {
		return "\n(No previous ideas yet — this is the first.)\n"
	}

	var b strings.Builder
	b.WriteString("\nIDEAS ALREADY USED FOR THIS PERSONA (you MUST invent something clearly DIFFERENT — do NOT rephrase any of these, and do not reuse their main subject):\n")

	for i, s := range avoid {
		if i > 0 {
			b.WriteByte('\n')
		}

		fmt.Fprintf(&b, "%d. %s", i+1, s)
	}

	b.WriteByte('\n')

	return b.String()
}

func nicheOrNone(n string) string {
	if n == "" {
		return "(none)"
	}

	return n
}

var (
	summaryRe   = regexp.MustCompile(`(?is)SUMMARY:\s*(.+?)\s*(?:\n\s*PROMPT:)`)
	promptRe    = regexp.MustCompile(`(?is)PROMPT:\s*(.+)$`)
	fenceRe     = regexp.MustCompile("(?i)^```[a-z]*\\n?|```$")
	sumLineRe   = regexp.MustCompile(`(?i)SUMMARY:\s*(.+)`)
	mainRe      = regexp.MustCompile(`(?is)MAIN:\s*(.+?)\n\s*SUB:`)
	subRe       = regexp.MustCompile(`(?is)SUB:\s*(.+)$`)
	innerSpace  = regexp.MustCompile(`\s*\n\s*`)
	edgeQuotesR = regexp.MustCompile(`^["']|["']$`)
)

func (s *Service) chat(ctx context.Context, sys, user string, maxTokens int) (string, error) {
	cctx, cancel := context.WithTimeout(ctx, callTimeout) // a hung LLM fails this try, not the run
	defer cancel()

	return s.llm.Chat(cctx, sys, user, maxTokens)
}

func (s *Service) freeIdea(ctx context.Context, master, niche string, avoid []string) (string, string, error) {
	user := strings.NewReplacer("{{NICHE}}", nicheOrNone(niche), "{{MASTER}}", master, "{{AVOID}}", AvoidClause(avoid)).Replace(ideaUser)

	out, err := s.chat(ctx, ideaSystem, user, 2000)
	if err != nil {
		return "", "", err
	}

	return ParseIdea(out)
}

// ParseIdea reads a "SUMMARY: … PROMPT: …" reply.
func ParseIdea(out string) (string, string, error) {
	sm, pm := summaryRe.FindStringSubmatch(out), promptRe.FindStringSubmatch(out)
	if sm == nil || pm == nil {
		return "", "", fmt.Errorf("LLM output missing SUMMARY/PROMPT: %s", truncate(out, 160))
	}

	summary := firstLine(sm[1])

	prompt := strings.TrimSpace(fenceRe.ReplaceAllString(strings.TrimSpace(pm[1]), ""))
	if summary == "" || len(prompt) < 40 {
		return "", "", errors.New("summary/prompt too short")
	}

	return summary, prompt, nil
}

// AnimalPair is the chaser (Main) and chased (Sub) designs of one idea.
type AnimalPair struct{ Summary, Main, Sub string }

func (s *Service) animals(ctx context.Context, guide, niche string, avoid []string) (AnimalPair, error) {
	user := strings.NewReplacer("{{NICHE}}", nicheOrNone(niche), "{{GUIDE}}", guide, "{{AVOID}}", AvoidClause(avoid)).Replace(animalsUser)

	out, err := s.chat(ctx, animalsSystem, user, 1200)
	if err != nil {
		return AnimalPair{}, err
	}

	return ParseAnimals(out)
}

// ParseAnimals reads a "SUMMARY: … MAIN: … SUB: …" reply.
func ParseAnimals(out string) (AnimalPair, error) {
	sm, mm, um := sumLineRe.FindStringSubmatch(out), mainRe.FindStringSubmatch(out), subRe.FindStringSubmatch(out)
	if sm == nil || mm == nil || um == nil {
		return AnimalPair{}, fmt.Errorf("LLM output missing SUMMARY/MAIN/SUB: %s", truncate(out, 160))
	}

	clean := func(s string) string {
		return strings.TrimSpace(edgeQuotesR.ReplaceAllString(innerSpace.ReplaceAllString(strings.TrimSpace(s), " "), ""))
	}

	p := AnimalPair{Summary: firstLine(sm[1]), Main: clean(mm[1]), Sub: clean(um[1])}
	if p.Summary == "" || len(p.Main) < 40 || len(p.Sub) < 40 {
		return AnimalPair{}, errors.New("animal designs too short")
	}

	return p, nil
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}

	return strings.TrimSpace(s)
}

func roundTo(f float64, places int) float64 {
	v, _ := strconv.ParseFloat(strconv.FormatFloat(f, 'f', places, 64), 64)
	return v
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}

	return string(r[:n])
}
