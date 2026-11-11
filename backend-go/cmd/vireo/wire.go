package main

import (
	"context"
	"os"
	"path/filepath"
	"time"

	"github.com/Faresapn/vireo/backend-go/internal/adapter/embedding"
	"github.com/Faresapn/vireo/backend-go/internal/adapter/higgsfield"
	"github.com/Faresapn/vireo/backend-go/internal/adapter/keystore"
	"github.com/Faresapn/vireo/backend-go/internal/adapter/llm"
	"github.com/Faresapn/vireo/backend-go/internal/adapter/media"
	"github.com/Faresapn/vireo/backend-go/internal/adapter/osfs"
	"github.com/Faresapn/vireo/backend-go/internal/adapter/repository"
	"github.com/Faresapn/vireo/backend-go/internal/adapter/steps"
	"github.com/Faresapn/vireo/backend-go/internal/adapter/transit"
	"github.com/Faresapn/vireo/backend-go/internal/adapter/uploader"
	"github.com/Faresapn/vireo/backend-go/internal/archive"
	"github.com/Faresapn/vireo/backend-go/internal/autopilot"
	"github.com/Faresapn/vireo/backend-go/internal/entity"
	"github.com/Faresapn/vireo/backend-go/internal/idea"
	"github.com/Faresapn/vireo/backend-go/internal/ingest"
	"github.com/Faresapn/vireo/backend-go/internal/prompt"
	"github.com/Faresapn/vireo/backend-go/internal/render"
	"github.com/Faresapn/vireo/backend-go/internal/screen"
)

// Manual constructor injection: one function per use case.

func home() string {
	h, _ := os.UserHomeDir()
	return h
}

func (a *app) worker(ctx context.Context) (*repository.Worker, error) {
	db, err := a.open(ctx)
	if err != nil {
		return nil, err
	}

	return repository.NewWorker(db), nil
}

func vision() (*llm.Client, error) {
	return llm.NewFromKeyFile(filepath.Join(home(), ".llm_vision_key"))
}

func (a *app) ingestService(ctx context.Context) (*ingest.Service, error) {
	w, err := a.worker(ctx)
	if err != nil {
		return nil, err
	}

	ve, err := viralEngine("higgsfield-ingest")
	if err != nil {
		return nil, err
	}

	return ingest.NewService(w, signals{Client: ve}, media.Tools{}, a.personasDir(), logf), nil
}

func (a *app) screenService(ctx context.Context) (*screen.Service, error) {
	w, err := a.worker(ctx)
	if err != nil {
		return nil, err
	}

	v, err := vision()
	if err != nil {
		return nil, err
	}

	return screen.NewService(w, media.Tools{}, v, a.personasDir()), nil
}

func (a *app) promptService(ctx context.Context) (*prompt.Service, error) {
	w, err := a.worker(ctx)
	if err != nil {
		return nil, err
	}

	v, err := vision()
	if err != nil {
		return nil, err
	}

	return prompt.NewService(w, media.Tools{}, v, a.personasDir(), logf, nil), nil
}

func (a *app) ideaService(ctx context.Context) (*idea.Service, error) {
	w, err := a.worker(ctx)
	if err != nil {
		return nil, err
	}

	v, err := vision()
	if err != nil {
		return nil, err
	}

	return idea.NewService(w, v, embedding.New(nil, embedding.DefaultURL), logf, time.Now), nil
}

func (a *app) archiveService(ctx context.Context, remote, rclone string) (*archive.Service, error) {
	db, err := a.open(ctx)
	if err != nil {
		return nil, err
	}

	return archive.NewService(repository.NewArchiveSQLite(db), uploader.NewRclone(rclone, remote), osfs.FS{}, a.personasDir(), time.Now), nil
}

// renderKeys reads the Higgsfield key files on every render; the Seedance
// slot falls back to the Wan key when the second file is missing.
type renderKeys struct{ store *keystore.File }

func (k renderKeys) Key(slot entity.KeySlot) string {
	key, _ := k.store.Read(slot)
	if key == "" && slot == entity.SlotSeedance {
		key, _ = k.store.Read(entity.SlotWan)
	}

	return string(key)
}

// archiveAdapter lets render archive skip-QC outputs in-process.
type archiveAdapter struct{ svc *archive.Service }

func (a archiveAdapter) Archive(ctx context.Context, personaID string, videoID int64) error {
	_, err := a.svc.Archive(ctx, personaID, videoID, false)
	return err
}

func r2FromEnv() transit.R2 {
	return transit.R2{
		Remote: "r2",
		Bucket: envOr("R2_BUCKET", "media"),
		Prefix: envOr("R2_PREFIX", "higgsfield-transit"),
		CDN:    envOr("R2_CDN", "https://your-r2-cdn.example.com"),
	}
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}

	return def
}

func (a *app) renderService(ctx context.Context) (*render.Service, error) {
	w, err := a.worker(ctx)
	if err != nil {
		return nil, err
	}

	arch, err := a.archiveService(ctx, "gdrive:", "rclone")
	if err != nil {
		return nil, err
	}

	return render.NewService(render.Config{
		Repo:        w,
		Transit:     r2FromEnv(),
		Media:       media.Tools{},
		Higgsfield:  &higgsfield.Client{Log: logf},
		Keys:        renderKeys{keystore.NewFile(home(), "~")},
		Archive:     archiveAdapter{arch},
		PersonasDir: a.personasDir(),
		Log:         logf,
	}), nil
}

func (a *app) autopilot(ctx context.Context) (*autopilot.Service, error) {
	w, err := a.worker(ctx)
	if err != nil {
		return nil, err
	}

	self, err := os.Executable()
	if err != nil {
		return nil, err
	}

	return autopilot.NewService(w, steps.Exec{Bin: self, Root: a.root}, logf), nil
}
