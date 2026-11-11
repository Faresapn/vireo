package repository_test

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/Faresapn/vireo/backend-go/internal/adapter/repository"
	"github.com/Faresapn/vireo/backend-go/internal/entity"
)

func newWorker(t *testing.T) (*repository.Worker, *sql.DB) {
	t.Helper()

	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "studio.db"))
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = db.Close() })

	if _, err := db.ExecContext(context.Background(), schema+`;
		ALTER TABLE videos ADD COLUMN ingested_at TEXT;
		ALTER TABLE videos ADD COLUMN updated_at TEXT;
		CREATE TABLE idea_vectors (id INTEGER PRIMARY KEY, persona_id TEXT, video_id INTEGER, summary TEXT, vector TEXT, created_at TEXT);
		CREATE TABLE character_images (id INTEGER PRIMARY KEY, persona_id TEXT, rel_path TEXT, ord INTEGER, video_id INTEGER);
		INSERT INTO character_images (persona_id, rel_path, ord, video_id) VALUES
		  ('denvo', 'char/b.jpg', 1, NULL), ('denvo', 'char/a.jpg', 0, NULL), ('denvo', 'char/own.jpg', 0, 5);
		UPDATE videos SET ingested_at = datetime('now', '-13 hours') WHERE id = 1;
		UPDATE videos SET ingested_at = datetime('now') WHERE id = 2;
		UPDATE videos SET ref_score = 80 WHERE id = 3;`); err != nil {
		t.Fatal(err)
	}

	return repository.NewWorker(db), db
}

func TestWorkerQueries(t *testing.T) {
	t.Parallel()
	w, db := newWorker(t)
	ctx := context.Background()

	stale, err := w.StaleInbox(ctx, "denvo", 12)
	if err != nil || len(stale) != 1 || stale[0].ID != 1 {
		t.Fatalf("StaleInbox = %v, %v", stale, err)
	}

	imgs, _ := w.CharacterImages(ctx, "denvo", 4)

	own, _ := w.CharacterImages(ctx, "denvo", 5)
	if len(imgs) != 2 || imgs[0] != "char/a.jpg" || len(own) != 1 || own[0] != "char/own.jpg" {
		t.Fatalf("persona images %v, video-scoped %v", imgs, own)
	}

	if err := w.PenalizeRef(ctx, 3); err != nil {
		t.Fatal(err)
	}

	var score int
	if err := db.QueryRowContext(ctx, "SELECT ref_score FROM videos WHERE id = 3").Scan(&score); err != nil || score != 20 {
		t.Fatalf("penalized score = %d, %v", score, err)
	}

	prompt, req := "P", "req"
	if err := w.FinishRender(ctx, entity.RenderDone{
		VideoID: 4, Column: "output_480", OutputRel: "output/480p/x.mp4",
		Prompt: &prompt, RequestID: &req, Stage: entity.StageDone,
	}); err != nil {
		t.Fatal(err)
	}

	var out, stage, qc, pu, hf string
	if err := db.QueryRowContext(ctx, "SELECT output_480, stage, qc_status, prompt_used, hf_request_id FROM videos WHERE id = 4").
		Scan(&out, &stage, &qc, &pu, &hf); err != nil {
		t.Fatal(err)
	}

	if out != "output/480p/x.mp4" || stage != "done" || qc != "ok" || pu != "P" || hf != "req" {
		t.Fatalf("finished row = %s %s %s %s %s", out, stage, qc, pu, hf)
	}

	id, err := w.InsertIdea(ctx, "denvo", "idea1", "prompt", "summary", []float64{0.5, 0.25})
	if err != nil {
		t.Fatal(err)
	}

	ivs, _ := w.IdeaVectors(ctx, "denvo")
	if id == 0 || len(ivs) != 1 || ivs[0].Vector[1] != 0.25 {
		t.Fatalf("idea id %d vectors %+v", id, ivs)
	}

	msg, err := w.ResetStuckRender(ctx, 4, "fallback")
	if err != nil || msg != "generate gagal" {
		t.Fatalf("a finished render must not be reset: %q %v", msg, err)
	}
}
