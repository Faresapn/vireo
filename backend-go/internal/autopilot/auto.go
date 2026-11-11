package autopilot

import (
	"cmp"
	"context"
	"fmt"
	"math"
	"regexp"
	"slices"
	"strings"

	"github.com/Faresapn/vireo/backend-go/internal/entity"
)

// AutoOptions mirror auto_generate.mjs flags.
type AutoOptions struct {
	Count      int                // videos to make, default 1
	Resolution string             // "" = persona render_res
	Order      entity.IngestOrder // "date" prefers the newest refs
	Fresh      bool               // ingest before the first video even if the inbox has refs
	MaxDur     float64            // skip refs longer than this (0 = no limit)
}

// VideoResult is one video's outcome.
type VideoResult struct {
	OK         bool   `json:"ok"`
	Shortcode  string `json:"shortcode,omitempty"`
	Engine     string `json:"engine,omitempty"`
	Resolution string `json:"resolution,omitempty"`
	Stage      string `json:"stage,omitempty"`
	Reason     string `json:"reason,omitempty"`
}

// AutoResult is printed as JSON.
type AutoResult struct {
	OK      bool          `json:"ok"`
	Persona string        `json:"persona"`
	Count   int           `json:"count"`
	Results []VideoResult `json:"results"`
}

// Tuning from auto_generate.mjs.
const (
	refAttempts  = 3  // different refs tried per video (nsfw/copyright blocks happen)
	screenTop    = 15 // top-velocity candidates screened
	viableScore  = 45 // screened refs below this are never picked
	neutralScore = 50 // used when screening fails
	failedScore  = 20 // a ref that failed to render
)

// predator refs are forced to Seedance (Genjutsu flags big predators as NSFW).
var predator = regexp.MustCompile(`(?i)lion|tiger|singa|harimau|bear|beruang|wolf|serigala|leopard|cheetah|panther|jaguar`)

// Service runs the autopilot.
type Service struct {
	repo  Repository
	steps Steps
	log   func(string, ...any)
}

// NewService builds a Service.
func NewService(repo Repository, steps Steps, log func(string, ...any)) *Service {
	return &Service{repo: repo, steps: steps, log: log}
}

// PickEngine chooses an engine for a ref when the persona has none locked.
// Refs over 15s need a 30s-capable engine (Seedance 2.0 truncates at 15s).
func (s *Service) PickEngine(ctx context.Context, niche, caption string, durationS float64) (entity.Engine, error) {
	isPredator := predator.MatchString(caption)
	if durationS > 15 {
		if isPredator {
			return entity.EngineSeedance25, nil
		}

		return entity.EngineGenjutsu, nil
	}

	if isPredator {
		return entity.EngineSeedance, nil
	}

	best, err := s.repo.BestEngine(ctx, niche)
	if err != nil {
		return "", err
	}

	return cmp.Or(best, entity.EngineSeedance), nil
}

func f64(p *float64) float64 {
	if p == nil {
		return 0
	}

	return *p
}

// PickRef chooses the best inbox reference not in tried: screen the top
// velocity candidates, keep those scoring >= 45, rank by suitability (55%),
// velocity (25%) and fit to the niche's winning duration (20%). With an
// order it prefers refs pulled with that order, falling back to the whole
// inbox when none of those is viable. Returns nil when nothing is viable:
// never force a bad ref (it wastes credits).
func (s *Service) PickRef(ctx context.Context, p entity.Persona, tried map[int64]bool, order entity.IngestOrder, maxDur float64) (*entity.Video, error) {
	all, err := s.repo.Inbox(ctx, p.ID)
	if err != nil {
		return nil, err
	}

	inbox, narrowed := candidates(all, tried, order, maxDur)
	if len(inbox) == 0 {
		return nil, nil
	}

	top := s.screenTop(ctx, p.ID, inbox)

	avg, n, err := s.repo.OKDurationStats(ctx, p.Niche)
	if err != nil {
		return nil, err
	}

	if n < 3 {
		avg = 12
	}

	best := bestViable(top, avg)
	if best == nil && narrowed {
		return s.PickRef(ctx, p, tried, "", maxDur)
	}

	return best, nil
}

// candidates drops tried and over-long refs and, with an order, narrows to
// refs pulled with it (only when that leaves some but not all).
func candidates(all []entity.Video, tried map[int64]bool, order entity.IngestOrder, maxDur float64) ([]entity.Video, bool) {
	var inbox []entity.Video

	for _, v := range all {
		d := f64(v.DurationS)
		if tried[v.ID] || (maxDur > 0 && (d <= 0 || d > maxDur)) {
			continue
		}

		inbox = append(inbox, v)
	}

	if order == "" {
		return inbox, false
	}

	var same []entity.Video

	for _, v := range inbox {
		if str(v.IngestOrder) == string(order) {
			same = append(same, v)
		}
	}

	if len(same) > 0 && len(same) < len(inbox) {
		return same, true
	}

	return inbox, false
}

// screenTop screens (if not yet scored) the fastest-growing candidates.
func (s *Service) screenTop(ctx context.Context, personaID string, inbox []entity.Video) []entity.Video {
	top := slices.Clone(inbox)
	slices.SortStableFunc(top, func(a, b entity.Video) int { return cmp.Compare(f64(b.ViewsPerHour), f64(a.ViewsPerHour)) })

	top = top[:min(len(top), screenTop)]
	for i := range top {
		v := &top[i]
		if v.RefScore != nil {
			continue
		}

		score, verdict, reason, err := s.steps.Screen(ctx, personaID, v.ID)
		if err != nil {
			score = neutralScore

			s.log("  screen %s: failed, neutral 50", str(v.Shortcode))
		} else {
			s.log("  screen %s: %d (%s) — %s", str(v.Shortcode), score, verdict, reason)
		}

		v.RefScore = new(int64(score))
	}

	return top
}

// bestViable ranks refs scoring >= viableScore and returns the best, or nil.
func bestViable(top []entity.Video, avgDur float64) *entity.Video {
	maxVph := 1.0
	for _, v := range top {
		maxVph = max(maxVph, f64(v.ViewsPerHour))
	}

	score := func(v entity.Video) float64 {
		durPen := math.Min(math.Abs(cmp.Or(f64(v.DurationS), 12)-avgDur)/15, 1)

		durFit := 0.5
		if d := f64(v.DurationS); d >= 4 && d <= 15 {
			durFit = 1
		}

		return refScore(v)/100*0.55 + f64(v.ViewsPerHour)/maxVph*0.25 + (1-durPen)*0.1 + durFit*0.1
	}

	var viable []entity.Video

	for _, v := range top {
		if refScore(v) >= viableScore {
			viable = append(viable, v)
		}
	}

	if len(viable) == 0 {
		return nil
	}

	slices.SortStableFunc(viable, func(a, b entity.Video) int { return cmp.Compare(score(b), score(a)) })

	return &viable[0]
}

func refScore(v entity.Video) float64 {
	if v.RefScore == nil {
		return neutralScore
	}

	return float64(*v.RefScore)
}

func str(p *string) string {
	if p == nil {
		return ""
	}

	return *p
}

// Auto makes opts.Count videos for a persona.
func (s *Service) Auto(ctx context.Context, personaID string, opts AutoOptions) (AutoResult, error) {
	p, err := s.repo.Persona(ctx, personaID)
	if err != nil {
		return AutoResult{}, err
	}

	count := max(opts.Count, 1)
	out := AutoResult{OK: true, Persona: personaID, Count: count, Results: []VideoResult{}}

	for i := range count {
		s.log("\n===== AUTO video %d/%d =====", i+1, count)

		n, err := s.repo.InboxCount(ctx, personaID)
		if err != nil {
			return AutoResult{}, err
		}

		if n == 0 || (opts.Fresh && i == 0) {
			s.log("Ingest dari MCP (%s)…", cmp.Or(string(opts.Order), "velocity"))

			if err := s.steps.Ingest(ctx, personaID, 8, opts.Order); err != nil {
				s.log("ingest gagal: %v", err)
			}
		}

		res, err := s.oneVideo(ctx, p, opts)
		if err != nil {
			return AutoResult{}, err
		}

		out.Results = append(out.Results, res)
	}

	return out, nil
}

func (s *Service) oneVideo(ctx context.Context, p entity.Persona, opts AutoOptions) (VideoResult, error) {
	tried := map[int64]bool{}
	for attempt := range refAttempts {
		ref, err := s.PickRef(ctx, p, tried, opts.Order, opts.MaxDur)
		if err != nil {
			return VideoResult{}, err
		}

		if ref == nil {
			s.log("tidak ada ref viable di INBOX")
			return VideoResult{OK: false, Reason: "no ref"}, nil
		}

		tried[ref.ID] = true
		s.log("[attempt %d] Ref: %s (%.0fs, score %d, %.0f/h)", attempt+1, str(ref.Shortcode), f64(ref.DurationS), int(refScore(*ref)), f64(ref.ViewsPerHour))

		res, done, err := s.tryRef(ctx, p, *ref, opts)
		if err != nil || done {
			return res, err
		}
	}

	return VideoResult{OK: false, Reason: fmt.Sprintf("all refs blocked/failed after %d tries", refAttempts)}, nil
}

// tryRef runs prompt → engine → render for one ref. done is false when the
// caller should try another ref.
func (s *Service) tryRef(ctx context.Context, p entity.Persona, ref entity.Video, opts AutoOptions) (VideoResult, bool, error) {
	if err := s.repo.SetStage(ctx, ref.ID, entity.StageShortlist); err != nil {
		return VideoResult{}, false, err
	}

	s.log("Build prompt (vision)…")

	if err := s.steps.BuildPrompt(ctx, p.ID, ref.ID, strings.TrimSpace(str(p.AutoInstruction))); err != nil {
		s.log("build_prompt gagal: %v", err)
		return VideoResult{}, false, nil
	}

	engine, err := s.engineFor(ctx, p, ref)
	if err != nil {
		return VideoResult{}, false, err
	}

	rag, err := s.repo.RAGStats(ctx, p.Niche)
	if err != nil {
		return VideoResult{}, false, err
	}

	res := cmp.Or(opts.Resolution, p.Resolution())
	s.log("Resolution: %s (RAG first-try %.0f%%, %d samples)", res, rag.Rate()*100, rag.FirstTries)

	if err := s.steps.Generate(ctx, p.ID, ref.ID, engine, res); err != nil {
		s.log("generate gagal (%s), coba ref lain…", str(ref.Shortcode))
		return VideoResult{}, false, s.repo.PenalizeRef(ctx, ref.ID)
	}

	out := VideoResult{OK: true, Shortcode: str(ref.Shortcode), Engine: string(engine), Resolution: res}
	stage, err := s.settle(ctx, p.ID, ref.ID, rag)
	out.Stage = string(stage)

	return out, true, err
}

// engineFor is the persona's locked engine, else an automatic pick.
func (s *Service) engineFor(ctx context.Context, p entity.Persona, ref entity.Video) (entity.Engine, error) {
	if e := entity.Engine(strings.TrimSpace(str(p.AutoEngine))); e != "" {
		s.log("Engine: %s (locked) (ref %.0fs)", e, f64(ref.DurationS))
		return e, nil
	}

	e, err := s.PickEngine(ctx, p.Niche, str(ref.Caption), f64(ref.DurationS))
	if err == nil {
		s.log("Engine: %s (auto) (ref %.0fs)", e, f64(ref.DurationS))
	}

	return e, err
}

// settle marks a proven niche's render done (and archives it); otherwise it
// reports the stage the render command left (done for skip-QC personas).
func (s *Service) settle(ctx context.Context, personaID string, videoID int64, rag entity.RAGStats) (entity.Stage, error) {
	if rag.AutoDone() {
		if err := s.repo.MarkDone(ctx, videoID); err != nil {
			return "", err
		}

		if err := s.steps.Archive(ctx, personaID, videoID); err != nil {
			s.log("archive gagal: %v", err)
		}

		s.log("AUTO-DONE (RAG proven) + archived to Drive")

		return entity.StageDone, nil
	}

	stage, err := s.repo.VideoStage(ctx, videoID)
	if err != nil {
		stage = entity.StageQC
	}

	if stage == entity.StageDone {
		s.log("Langsung HASIL (skip QC)")
	} else {
		s.log("Masuk QC (nunggu review manual)")
	}

	return stage, nil
}
