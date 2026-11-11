package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/Faresapn/vireo/backend-go/internal/archive"
	"github.com/Faresapn/vireo/backend-go/internal/entity"
)

// ArchiveSQLite implements archive.Repository. It needs a writable handle:
// it records drive_synced and drive_name.
type ArchiveSQLite struct {
	db *sql.DB
}

// NewArchiveSQLite wraps a writable database handle.
func NewArchiveSQLite(db *sql.DB) *ArchiveSQLite {
	return &ArchiveSQLite{db: db}
}

// Persona loads one persona.
func (r *ArchiveSQLite) Persona(ctx context.Context, id string) (archive.Persona, error) {
	var p archive.Persona

	err := r.db.QueryRowContext(ctx,
		"SELECT id, name, viral_cluster_slug, drive_folder_id FROM personas WHERE id = ?", id,
	).Scan(&p.ID, &p.Name, &p.ViralClusterSlug, &p.DriveFolderID)
	if errors.Is(err, sql.ErrNoRows) {
		return archive.Persona{}, entity.ErrPersonaNotFound
	}

	if err != nil {
		return archive.Persona{}, fmt.Errorf("loading persona: %w", err)
	}

	return p, nil
}

// Video loads one of the persona's videos.
func (r *ArchiveSQLite) Video(ctx context.Context, personaID string, videoID int64) (archive.Video, error) {
	var v archive.Video

	err := r.db.QueryRowContext(ctx,
		"SELECT id, local_ref, output_480, output_1080, drive_name FROM videos WHERE id = ? AND persona_id = ?",
		videoID, personaID,
	).Scan(&v.ID, &v.LocalRef, &v.Output480, &v.Output1080, &v.DriveName)
	if errors.Is(err, sql.ErrNoRows) {
		return archive.Video{}, entity.ErrVideoNotFound
	}

	if err != nil {
		return archive.Video{}, fmt.Errorf("loading video: %w", err)
	}

	return v, nil
}

// likeEscaper makes a LIKE pattern match its text literally ("_" and "%" are
// wildcards, and every Drive name contains "_").
var likeEscaper = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)

// DriveNames lists the persona's drive names that start with prefix.
func (r *ArchiveSQLite) DriveNames(ctx context.Context, personaID, prefix string) ([]string, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT drive_name FROM videos WHERE persona_id = ? AND drive_name LIKE ? ESCAPE '\'`,
		personaID, likeEscaper.Replace(prefix)+"%",
	)
	if err != nil {
		return nil, fmt.Errorf("querying drive names: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var names []string

	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, fmt.Errorf("scanning drive name: %w", err)
		}

		names = append(names, n)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterating drive names: %w", err)
	}

	return names, nil
}

// MarkSynced records a successful upload.
func (r *ArchiveSQLite) MarkSynced(ctx context.Context, videoID int64, name *string) error {
	var err error
	if name != nil {
		_, err = r.db.ExecContext(ctx,
			"UPDATE videos SET drive_synced = 1, drive_name = ?, updated_at = datetime('now') WHERE id = ?", *name, videoID)
	} else {
		_, err = r.db.ExecContext(ctx,
			"UPDATE videos SET drive_synced = 1, updated_at = datetime('now') WHERE id = ?", videoID)
	}

	if err != nil {
		return fmt.Errorf("updating video: %w", err)
	}

	return nil
}
