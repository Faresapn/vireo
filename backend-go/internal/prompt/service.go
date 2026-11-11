// Package prompt writes the final render prompt for a reference video: the
// vision LLM fills the [SLOTS] of the persona's master prompt from three
// frames of the reference (or, in story mode, writes a variation).
package prompt

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"math/rand/v2"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/Faresapn/vireo/backend-go/internal/adapter/llm"
	"github.com/Faresapn/vireo/backend-go/internal/entity"
)

var (
	//go:embed prompts/slot_system.txt
	slotSystem string
	//go:embed prompts/story_system.txt
	storySystem string
	//go:embed prompts/safe_rule.txt
	safeRule string
	//go:embed prompts/voice_duo.txt
	voiceDuo string
	//go:embed prompts/voice_single.txt
	voiceSingle string
	//go:embed prompts/user.txt
	userTemplate string
)

// Repository is the storage prompt building needs.
type Repository interface {
	Persona(ctx context.Context, id string) (entity.Persona, error)
	Video(ctx context.Context, personaID string, videoID int64) (entity.Video, error)
	SavePrompt(ctx context.Context, videoID int64, prompt string) error
}

// Media grabs frames.
type Media interface {
	Frames(ctx context.Context, path string, fractions []float64, width int, fallbackDur float64) ([][]byte, error)
}

// Vision is the multimodal LLM.
type Vision interface {
	ChatParts(ctx context.Context, system string, parts []llm.Part, maxTokens int) (string, error)
}

// Service builds prompts.
type Service struct {
	repo        Repository
	media       Media
	vision      Vision
	personasDir string
	log         func(string, ...any)
	pick        func(n int) int
}

// NewService builds a Service. pick chooses a random variant (nil = math/rand).
func NewService(repo Repository, m Media, v Vision, personasDir string, log func(string, ...any), pick func(int) int) *Service {
	if pick == nil {
		pick = rand.IntN
	}

	return &Service{repo: repo, media: m, vision: v, personasDir: personasDir, log: log, pick: pick}
}

// Errors returned by Build.
var (
	ErrNoMaster   = errors.New("no master_prompt (video or persona)")
	ErrRefMissing = errors.New("ref file missing")
	ErrTooShort   = errors.New("prompt too short / empty")
)

var variantRe = regexp.MustCompile(`\{\{([^{}]+)\}\}`)

// PickVariants replaces every {{a|b|c}} with one random option, so a persona
// can vary e.g. wardrobe per render.
func (s *Service) PickVariants(master string) string {
	return variantRe.ReplaceAllStringFunc(master, func(m string) string {
		var opts []string

		for o := range strings.SplitSeq(m[2:len(m)-2], "|") {
			if o = strings.TrimSpace(o); o != "" {
				opts = append(opts, o)
			}
		}

		if len(opts) == 0 {
			return ""
		}

		pick := opts[s.pick(len(opts))]
		s.log("[random] picked %q from %d options", pick, len(opts))

		return pick
	})
}

// Build writes and saves the prompt for a video. story switches to variation
// mode; instruction is an optional extra instruction (or story variation).
func (s *Service) Build(ctx context.Context, personaID string, videoID int64, story bool, instruction string) (string, error) {
	p, err := s.repo.Persona(ctx, personaID)
	if err != nil {
		return "", err
	}

	v, err := s.repo.Video(ctx, personaID, videoID)
	if err != nil {
		return "", err
	}

	master := s.master(p, v)
	if master == "" {
		return "", ErrNoMaster
	}

	ref, err := s.refPath(personaID, v)
	if err != nil {
		return "", err
	}

	isDuo := p.CharMode != nil && *p.CharMode == "duo"

	s.log("Extracting frames…")

	frames, err := s.media.Frames(ctx, ref, []float64{0.05, 0.45, 0.9}, 512, 10)
	if err != nil {
		return "", err
	}

	s.log("Vision building prompt%s%s%s", flag(story, " [STORY mode]"), flag(isDuo, " [DUO]"), flag(instruction != "", " + instruction"))

	parts := []llm.Part{llm.Text(UserText(p.Niche, master, instruction, story, voiceClause(isDuo, voiceCount(p))))}
	for _, f := range frames {
		parts = append(parts, llm.JPEG(f))
	}

	raw, err := s.vision.ChatParts(ctx, SystemPrompt(story), parts, 1200)
	if err != nil {
		return "", err
	}

	out := Sanitize(raw)
	if out != raw {
		s.log("[safe] rewrote risky wording for the content filter")
	}

	if len(out) < 50 {
		return "", ErrTooShort
	}

	return out, s.repo.SavePrompt(ctx, videoID, out)
}

// master is the video's own master prompt (freestyle), else the persona's,
// with random variants picked.
func (s *Service) master(p entity.Persona, v entity.Video) string {
	m := ""
	if v.MasterPrompt != nil {
		m = strings.TrimSpace(*v.MasterPrompt)
	}

	if m == "" && p.MasterPrompt != nil {
		m = strings.TrimSpace(*p.MasterPrompt)
	}

	if m == "" {
		return ""
	}

	return s.PickVariants(m)
}

func (s *Service) refPath(personaID string, v entity.Video) (string, error) {
	if v.LocalRef == nil {
		return "", ErrRefMissing
	}

	ref := filepath.Join(s.personasDir, personaID, *v.LocalRef)
	if _, err := os.Stat(ref); err != nil {
		return "", ErrRefMissing
	}

	return ref, nil
}

// SystemPrompt is the slot-filler (or story) system prompt with the safety rule.
func SystemPrompt(story bool) string {
	sys := slotSystem
	if story {
		sys = storySystem
	}

	return strings.ReplaceAll(sys, "{{SAFE_RULE}}", safeRule)
}

// UserText is the user message that goes with the frames.
func UserText(niche, master, instruction string, story bool, voice string) string {
	mode := "AUTHORITATIVE — reproduce verbatim, fill ONLY the [SLOTS], add nothing"
	label := "EXTRA INSTRUCTION"

	if story {
		mode = "keep character locked, motion same, VARY the content"
		label = "STORY VARIATION"
	}

	instr := ""
	if instruction != "" {
		instr = "\n" + label + " (apply this): " + instruction + "\n"
	}

	return strings.NewReplacer(
		"{{NICHE}}", niche, "{{MODE_NOTE}}", mode, "{{MASTER}}", master,
		"{{INSTRUCTION}}", instr, "{{VOICE}}", voice,
	).Replace(userTemplate)
}

func voiceClause(isDuo bool, voices int) string {
	switch {
	case isDuo && voices >= 2:
		return "\n" + voiceDuo
	case voices >= 1:
		return "\n" + voiceSingle
	}

	return ""
}

// voiceCount is how many reference voices a persona sends (audio_mode "ref").
func voiceCount(p entity.Persona) int {
	if p.AudioMode == nil || *p.AudioMode != "ref" || p.AudioRef == nil || *p.AudioRef == "" {
		return 0
	}

	var refs []string
	if json.Unmarshal([]byte(*p.AudioRef), &refs) == nil {
		return len(refs)
	}

	return 1
}

func flag(on bool, s string) string {
	if on {
		return s
	}

	return ""
}
