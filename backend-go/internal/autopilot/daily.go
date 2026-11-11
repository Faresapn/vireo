package autopilot

import (
	"context"
	"fmt"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Faresapn/vireo/backend-go/internal/entity"
)

// Daily tuning from daily_auto.mjs.
const (
	// DailyMaxAttempts: a safety block is refunded and depends on the idea,
	// so one fresh idea gets one more try.
	DailyMaxAttempts = 2
	// ClusterMaxRefS: refs of 15s or less are too rare in these clusters.
	ClusterMaxRefS = 27
	defaultRes     = "720p"
)

var autoDurationRe = regexp.MustCompile(`(?m)^AUTO_DURATION:\s*(\d+)\s*$`)

// MasterDuration reads "AUTO_DURATION: <s>" from a master prompt (0 if absent).
func MasterDuration(master string) int {
	m := autoDurationRe.FindStringSubmatch(master)
	if m == nil {
		return 0
	}

	n, _ := strconv.Atoi(m[1])

	return n
}

// Daily runs every due persona once per local day.
type Daily struct {
	svc    *Service
	now    func() time.Time
	logDir string
	out    func(string) // dry-run lines (stdout)
}

// NewDaily builds the daily runner.
func NewDaily(svc *Service, now func() time.Time, logDir string, out func(string)) *Daily {
	if now == nil {
		now = time.Now
	}

	return &Daily{svc: svc, now: now, logDir: logDir, out: out}
}

func (d *Daily) date() string  { return d.now().Format("2006-01-02") }
func (d *Daily) stamp() string { return d.now().Format("2006-01-02 15:04") }

func resOf(p entity.Persona) string {
	if p.RenderRes != nil && *p.RenderRes == "480p" {
		return "480p"
	}

	return defaultRes
}

// Run executes (or with dryRun lists) today's personas.
func (d *Daily) Run(ctx context.Context, dryRun bool) error {
	repo := d.svc.repo

	ps, err := repo.DailyPersonas(ctx)
	if err != nil {
		return err
	}

	today := d.date()

	var due []entity.Persona

	for _, p := range ps {
		if p.DailyAutoLast == nil || *p.DailyAutoLast != today {
			due = append(due, p)
		}
	}

	d.svc.log("[%s] %d persona jalan hari ini (%d ON)", d.stamp(), len(due), len(ps))

	if dryRun {
		for _, p := range due {
			if str(p.ViralClusterSlug) != "" {
				d.out(fmt.Sprintf("%s cluster=%s engine=%s %s ref<=%ds newest+velocity",
					p.ID, *p.ViralClusterSlug, orDefault(str(p.AutoEngine), "auto"), resOf(p), ClusterMaxRefS))

				continue
			}

			dur := "NO AUTO_DURATION"
			if n := MasterDuration(str(p.MasterPrompt)); n > 0 {
				dur = strconv.Itoa(n)
			}

			d.out(fmt.Sprintf("%s idea %s %ss", p.ID, resOf(p), dur))
		}

		return nil
	}

	for _, p := range due {
		if err := d.runPersona(ctx, p, today); err != nil {
			d.svc.log("[%s] %s: %v", d.stamp(), p.ID, err)
		}
	}

	d.svc.log("[%s] selesai", d.stamp())

	return nil
}

func orDefault(s, def string) string {
	if s == "" {
		return def
	}

	return s
}

func (d *Daily) setStatus(ctx context.Context, p entity.Persona, text string) error {
	d.svc.log("[%s] %s: %s", d.stamp(), p.ID, text)
	return d.svc.repo.SetDailyStatus(ctx, p.ID, d.stamp()+" "+text)
}

func (d *Daily) runPersona(ctx context.Context, p entity.Persona, today string) error {
	if str(p.ViralClusterSlug) != "" {
		return d.runCluster(ctx, p, today)
	}

	return d.runIdeas(ctx, p, today)
}

// runCluster runs `auto` on the newest refs of at most ClusterMaxRefS.
func (d *Daily) runCluster(ctx context.Context, p entity.Persona, today string) error {
	if err := d.svc.repo.SetDailyLast(ctx, p.ID, today); err != nil {
		return err
	}

	res, err := d.svc.steps.Auto(ctx, p.ID, AutoOptions{
		Count: 1, Resolution: resOf(p), Order: entity.OrderDate, Fresh: true, MaxDur: ClusterMaxRefS,
	})
	if err == nil && len(res.Results) > 0 && res.Results[0].OK {
		r := res.Results[0]
		return d.setStatus(ctx, p, fmt.Sprintf("OK, ref %s (%s) masuk %s", r.Shortcode, r.Engine, strings.ToUpper(r.Stage)))
	}

	reason := "gagal"

	switch {
	case err != nil:
		reason = err.Error()
	case len(res.Results) > 0:
		reason = res.Results[0].Reason
	}

	return d.setStatus(ctx, p, "gagal: "+reason)
}

// runIdeas makes an idea and renders it; a safety block gets one fresh idea.
func (d *Daily) runIdeas(ctx context.Context, p entity.Persona, today string) error {
	dur := MasterDuration(str(p.MasterPrompt))
	if dur == 0 {
		return d.setStatus(ctx, p, "dilewati: master prompt belum ada baris AUTO_DURATION")
	}

	for attempt := 1; attempt <= DailyMaxAttempts; attempt++ {
		videoID, summary, err := d.svc.steps.Idea(ctx, p.ID)
		if err != nil {
			return d.setStatus(ctx, p, "gagal bikin ide")
		}
		// Marked only once an idea exists, so a dead LLM doesn't burn today's slot.
		if err := d.svc.repo.SetDailyLast(ctx, p.ID, today); err != nil {
			return err
		}

		d.svc.log("[%s] %s: ide %d (percobaan %d/%d): %s", d.stamp(), p.ID, videoID, attempt, DailyMaxAttempts, summary)

		ok, msg, err := d.render(ctx, p, videoID, dur)
		if err != nil {
			return err
		}

		if ok {
			where := "QC"
			if p.SkipQC != nil && *p.SkipQC != 0 {
				where = "HASIL"
			}

			return d.setStatus(ctx, p, fmt.Sprintf("OK, video %d masuk %s", videoID, where))
		}

		d.svc.log("[%s] %s: video %d gagal: %s", d.stamp(), p.ID, videoID, msg)

		if !strings.Contains(strings.ToLower(msg), "safety") || attempt == DailyMaxAttempts {
			return d.setStatus(ctx, p, fmt.Sprintf("gagal video %d: %s", videoID, truncate(msg, 120)))
		}
	}

	return nil
}

func (d *Daily) render(ctx context.Context, p entity.Persona, videoID int64, dur int) (bool, string, error) {
	repo := d.svc.repo
	if err := repo.StartRender(ctx, videoID, entity.EngineSeedance25); err != nil {
		return false, "", err
	}

	logFile := filepath.Join(d.logDir, fmt.Sprintf("gen_%s_%d_%d.log", p.ID, videoID, d.now().UnixMilli()))
	if err := d.svc.steps.GenerateI2V(ctx, p.ID, videoID, resOf(p), dur, logFile); err == nil {
		return true, "", nil
	}
	// Some failure paths (and timeouts) leave the video marked generating.
	msg, err := repo.ResetStuckRender(ctx, videoID, "auto: generate gagal, lihat "+filepath.Base(logFile))

	return false, msg, err
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}

	return string(r[:n])
}
