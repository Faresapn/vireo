// Package steps implements autopilot.Steps by running each step as a child
// `vireo` process: every render gets its own timeout and log file, and a crash
// in one step cannot take the orchestrator down. This mirrors how the Node
// orchestrators shelled out to the individual scripts.
package steps

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/Faresapn/vireo/backend-go/internal/autopilot"
	"github.com/Faresapn/vireo/backend-go/internal/entity"
)

// Per-step timeouts from the Node orchestrators.
const (
	IngestTimeout  = 5 * time.Minute
	ScreenTimeout  = 90 * time.Second
	PromptTimeout  = 2 * time.Minute
	RenderTimeout  = 45 * time.Minute // a render polls for up to 40 min
	ArchiveTimeout = 3 * time.Minute
	IdeaTimeout    = 6 * time.Minute
	ClusterTimeout = 2 * time.Hour // ingest + up to 3 refs × (screen + prompt + render)
)

// Exec runs `<Bin> -root <Root> <step> ...`.
type Exec struct {
	Bin    string    // path to the vireo binary (os.Executable())
	Root   string    // studio root
	Stderr io.Writer // where child progress goes (default os.Stderr)
}

func (e Exec) run(ctx context.Context, timeout time.Duration, stderr io.Writer, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	var stdout bytes.Buffer

	cmd := exec.CommandContext(ctx, e.Bin, append([]string{"--root", e.Root}, args...)...) //nolint:gosec // G204: our own binary
	cmd.Stdout = &stdout

	cmd.Stderr = stderr
	if cmd.Stderr == nil {
		cmd.Stderr = e.Stderr
	}

	if cmd.Stderr == nil {
		cmd.Stderr = os.Stderr
	}

	if err := cmd.Run(); err != nil {
		return stdout.Bytes(), fmt.Errorf("%s: %w", args[0], err)
	}

	return stdout.Bytes(), nil
}

// lastJSON decodes the last stdout line.
func lastJSON(out []byte, v any) error {
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), v); err != nil {
		return fmt.Errorf("decoding step output: %w", err)
	}

	return nil
}

func id(n int64) string { return strconv.FormatInt(n, 10) }

// Ingest runs `vireo ingest`.
func (e Exec) Ingest(ctx context.Context, personaID string, limit int, order entity.IngestOrder) error {
	args := []string{"ingest", personaID, strconv.Itoa(limit)}
	if order != "" {
		args = append(args, "--order", string(order))
	}

	_, err := e.run(ctx, IngestTimeout, nil, args...)

	return err
}

// Screen runs `vireo screen-ref`.
func (e Exec) Screen(ctx context.Context, personaID string, videoID int64) (int, string, string, error) {
	out, err := e.run(ctx, ScreenTimeout, nil, "screen-ref", personaID, id(videoID))
	if err != nil {
		return 0, "", "", err
	}

	var r struct {
		Score   float64 `json:"score"`
		Verdict string  `json:"verdict"`
		Reason  string  `json:"reason"`
	}
	if err := lastJSON(out, &r); err != nil {
		return 0, "", "", err
	}

	return int(math.Round(r.Score)), r.Verdict, r.Reason, nil
}

// BuildPrompt runs `vireo build-prompt`.
func (e Exec) BuildPrompt(ctx context.Context, personaID string, videoID int64, instruction string) error {
	args := []string{"build-prompt", personaID, id(videoID)}
	if instruction != "" {
		args = append(args, instruction)
	}

	_, err := e.run(ctx, PromptTimeout, nil, args...)

	return err
}

// Generate runs `vireo generate`.
func (e Exec) Generate(ctx context.Context, personaID string, videoID int64, engine entity.Engine, resolution string) error {
	_, err := e.run(ctx, RenderTimeout, nil, "generate", personaID, id(videoID), string(engine), resolution)
	return err
}

// Archive runs `vireo drive-archive`.
func (e Exec) Archive(ctx context.Context, personaID string, videoID int64) error {
	_, err := e.run(ctx, ArchiveTimeout, io.Discard, "drive-archive", personaID, id(videoID))
	return err
}

// Idea runs `vireo idea`.
func (e Exec) Idea(ctx context.Context, personaID string) (int64, string, error) {
	out, err := e.run(ctx, IdeaTimeout, nil, "idea", personaID)
	if err != nil {
		return 0, "", err
	}

	var r struct {
		OK      bool   `json:"ok"`
		VideoID int64  `json:"video_id"`
		Summary string `json:"summary"`
	}
	if err := lastJSON(out, &r); err != nil {
		return 0, "", err
	}

	if !r.OK || r.VideoID == 0 {
		return 0, "", errors.New("idea: no video id")
	}

	return r.VideoID, r.Summary, nil
}

// GenerateI2V runs `vireo generate-i2v`, logging to logFile.
func (e Exec) GenerateI2V(ctx context.Context, personaID string, videoID int64, resolution string, duration int, logFile string) error {
	f, err := os.OpenFile(logFile, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600) //nolint:gosec // G304: our log dir
	if err != nil {
		return fmt.Errorf("opening render log: %w", err)
	}
	defer func() { _ = f.Close() }()

	_, err = e.run(ctx, RenderTimeout, f, "generate-i2v", personaID, id(videoID), resolution, strconv.Itoa(duration))

	return err
}

// Auto runs `vireo auto` for one persona.
func (e Exec) Auto(ctx context.Context, personaID string, o autopilot.AutoOptions) (autopilot.AutoResult, error) {
	args := []string{"auto", personaID, strconv.Itoa(max(o.Count, 1))}
	if o.Resolution != "" {
		args = append(args, "--res", o.Resolution)
	}

	if o.Order != "" {
		args = append(args, "--order", string(o.Order))
	}

	if o.Fresh {
		args = append(args, "--fresh")
	}

	if o.MaxDur > 0 {
		args = append(args, "--max-dur", strconv.FormatFloat(o.MaxDur, 'f', -1, 64))
	}

	out, err := e.run(ctx, ClusterTimeout, nil, args...)

	var r autopilot.AutoResult
	if jerr := lastJSON(out, &r); jerr != nil {
		if err != nil {
			return r, err
		}

		return r, jerr
	}

	return r, err
}

var _ autopilot.Steps = Exec{}
