package repository_test

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"

	"github.com/Faresapn/vireo/backend-go/internal/adapter/repository"
	"github.com/Faresapn/vireo/backend-go/internal/entity"
)

func newArchiveRepo(t *testing.T) (*repository.ArchiveSQLite, *sql.DB) {
	t.Helper()

	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "studio.db"))
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = db.Close() })

	ctx := context.Background()
	if _, err := db.ExecContext(ctx, schema+`;
		ALTER TABLE videos ADD COLUMN drive_synced INTEGER DEFAULT 0;
		ALTER TABLE videos ADD COLUMN drive_name TEXT;
		ALTER TABLE videos ADD COLUMN updated_at TEXT;
		UPDATE videos SET drive_name = '11-11-2026_Denvo_2.mp4' WHERE id = 1;
		UPDATE videos SET drive_name = '11-11-2026_DenvoX1.mp4' WHERE id = 2;`); err != nil {
		t.Fatal(err)
	}

	return repository.NewArchiveSQLite(db), db
}

func TestArchiveRepo(t *testing.T) {
	t.Parallel()
	repo, db := newArchiveRepo(t)
	ctx := context.Background()

	if _, err := repo.Persona(ctx, "ghost"); !errors.Is(err, entity.ErrPersonaNotFound) {
		t.Fatalf("Persona(ghost) err = %v", err)
	}

	if _, err := repo.Video(ctx, "fish", 1); !errors.Is(err, entity.ErrVideoNotFound) {
		t.Fatalf("video of another persona: err = %v", err)
	}

	// "_" is a LIKE wildcard; the escaped prefix must not match "DenvoX1".
	names, err := repo.DriveNames(ctx, "denvo", "11-11-2026_Denvo_")
	if err != nil || len(names) != 1 || names[0] != "11-11-2026_Denvo_2.mp4" {
		t.Fatalf("DriveNames = %v, %v", names, err)
	}

	name := "11-11-2026_Denvo_3.mp4"
	if err := repo.MarkSynced(ctx, 3, &name); err != nil {
		t.Fatal(err)
	}

	var (
		synced int
		got    string
	)
	if err := db.QueryRowContext(ctx, "SELECT drive_synced, drive_name FROM videos WHERE id = 3").Scan(&synced, &got); err != nil {
		t.Fatal(err)
	}

	if synced != 1 || got != name {
		t.Fatalf("row = %d %q", synced, got)
	}
}
