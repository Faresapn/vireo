// Package autopilot runs the hands-off pipeline: auto (ingest → pick the best
// screened reference → prompt → render, retrying other refs) and the daily
// 11:00 run over every persona whose toggle is on.
package autopilot

import (
	"context"

	"github.com/Faresapn/vireo/backend-go/internal/entity"
)

// Repository is the storage the autopilot needs.
type Repository interface {
	Persona(ctx context.Context, id string) (entity.Persona, error)
	Inbox(ctx context.Context, personaID string) ([]entity.Video, error)
	InboxCount(ctx context.Context, personaID string) (int, error)
	OKDurationStats(ctx context.Context, niche string) (avg float64, n int, err error)
	RAGStats(ctx context.Context, niche string) (entity.RAGStats, error)
	BestEngine(ctx context.Context, niche string) (entity.Engine, error)
	SetStage(ctx context.Context, videoID int64, stage entity.Stage) error
	PenalizeRef(ctx context.Context, videoID int64) error
	MarkDone(ctx context.Context, videoID int64) error
	VideoStage(ctx context.Context, videoID int64) (entity.Stage, error)
	DailyPersonas(ctx context.Context) ([]entity.Persona, error)
	SetDailyLast(ctx context.Context, personaID, date string) error
	SetDailyStatus(ctx context.Context, personaID, status string) error
	StartRender(ctx context.Context, videoID int64, engine entity.Engine) error
	ResetStuckRender(ctx context.Context, videoID int64, fallback string) (string, error)
}

// Steps runs one pipeline step each. Production runs each as its own
// `vireo` process (own timeout and log, like the Node scripts did).
type Steps interface {
	Ingest(ctx context.Context, personaID string, limit int, order entity.IngestOrder) error
	Screen(ctx context.Context, personaID string, videoID int64) (score int, verdict, reason string, err error)
	BuildPrompt(ctx context.Context, personaID string, videoID int64, instruction string) error
	Generate(ctx context.Context, personaID string, videoID int64, engine entity.Engine, resolution string) error
	Archive(ctx context.Context, personaID string, videoID int64) error
	Idea(ctx context.Context, personaID string) (videoID int64, summary string, err error)
	GenerateI2V(ctx context.Context, personaID string, videoID int64, resolution string, duration int, logFile string) error
	Auto(ctx context.Context, personaID string, opts AutoOptions) (AutoResult, error)
}
