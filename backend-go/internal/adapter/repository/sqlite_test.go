package repository_test

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/Faresapn/vireo/backend-go/internal/adapter/repository"
	"github.com/Faresapn/vireo/backend-go/internal/entity"
)

// schema is a trimmed copy of the tables dashboard/lib/db.ts creates.
const schema = `
CREATE TABLE personas (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, niche TEXT NOT NULL, platform TEXT NOT NULL DEFAULT 'instagram',
  master_prompt TEXT, character_img TEXT, aspect TEXT, viral_source TEXT, viral_cluster_slug TEXT,
  archived INTEGER DEFAULT 0, auto_instruction TEXT, auto_mode INTEGER, auto_engine TEXT, char_mode TEXT,
  audio_mode TEXT, audio_ref TEXT, daily_auto INTEGER, daily_auto_last TEXT, daily_auto_status TEXT,
  render_res TEXT, skip_qc INTEGER, drive_folder_id TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE videos (
  id INTEGER PRIMARY KEY, persona_id TEXT NOT NULL, stage TEXT NOT NULL, source_url TEXT, local_ref TEXT,
  duration_s REAL, face_count INTEGER, cut_count INTEGER, ref_score INTEGER, ref_notes TEXT, shortcode TEXT,
  views INTEGER, views_per_hour REAL, caption TEXT, creator TEXT, prompt_used TEXT, idea_summary TEXT,
  master_prompt TEXT, hf_request_id TEXT, output_480 TEXT, output_1080 TEXT, qc_status TEXT, qc_notes TEXT,
  gen_engine TEXT, gen_error TEXT, gen_started_at TEXT, ingest_order TEXT, created_at TEXT);
INSERT INTO personas (id, name, niche, archived, render_res, created_at) VALUES
  ('denvo', 'Denvo', 'kids', 0, '480p', '2026-11-02'),
  ('old', 'Old', 'x', 1, NULL, '2026-11-03'),
  ('fish', 'Fishing', 'fishing', 0, NULL, '2026-11-01');
INSERT INTO videos (id, persona_id, stage, views_per_hour, ingest_order) VALUES
  (1, 'denvo', 'inbox', 10, 'velocity'),
  (2, 'denvo', 'inbox', 50, 'date'),
  (3, 'denvo', 'inbox', NULL, NULL),
  (4, 'denvo', 'generating', 1, NULL),
  (5, 'denvo', 'done', 1, NULL),
  (6, 'fish', 'qc', 1, NULL);`

func newRepo(t *testing.T) *repository.SQLite {
	t.Helper()

	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "studio.db"))
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = db.Close() })

	if _, err := db.ExecContext(context.Background(), schema); err != nil {
		t.Fatal(err)
	}

	return repository.NewSQLite(db)
}

func TestListOrdersAndCounts(t *testing.T) {
	t.Parallel()

	ps, err := newRepo(t).List(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	var ids []string
	for _, p := range ps {
		ids = append(ids, p.ID)
	}

	if want := []string{"denvo", "fish", "old"}; len(ids) != 3 || ids[0] != want[0] || ids[1] != want[1] || ids[2] != want[2] {
		t.Fatalf("order = %v, want %v (active first, newest first)", ids, want)
	}

	d := ps[0]
	if d.Inbox != 3 || d.Generating != 1 || d.Done != 1 || d.QC != 0 {
		t.Fatalf("denvo counts = %+v", d.StageCounts)
	}

	if d.Resolution() != "480p" || ps[1].Resolution() != "720p" {
		t.Fatal("Resolution() should follow render_res, defaulting to 720p")
	}
}

func TestVideosFilters(t *testing.T) {
	t.Parallel()
	repo := newRepo(t)

	tests := []struct {
		name   string
		filter entity.VideoFilter
		want   []int64
	}{
		{"all, by views per hour", entity.VideoFilter{}, []int64{2, 1, 5, 4, 3}},
		{"stage", entity.VideoFilter{Stage: entity.StageInbox}, []int64{2, 1, 3}},
		{"order keeps legacy refs", entity.VideoFilter{Stage: entity.StageInbox, Order: entity.OrderVelocity}, []int64{1, 3}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			vs, err := repo.Videos(context.Background(), "denvo", tt.filter)
			if err != nil {
				t.Fatal(err)
			}

			var got []int64
			for _, v := range vs {
				got = append(got, v.ID)
			}

			if len(got) != len(tt.want) {
				t.Fatalf("ids = %v, want %v", got, tt.want)
			}

			for i := range got {
				if got[i] != tt.want[i] {
					t.Fatalf("ids = %v, want %v", got, tt.want)
				}
			}
		})
	}
}

func TestExists(t *testing.T) {
	t.Parallel()

	repo := newRepo(t)
	for id, want := range map[string]bool{"denvo": true, "nobody": false} {
		got, err := repo.Exists(context.Background(), id)
		if err != nil || got != want {
			t.Fatalf("Exists(%q) = %v, %v; want %v", id, got, err, want)
		}
	}
}
