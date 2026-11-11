// Package repository implements the persona.Repository port on the studio's
// SQLite database (db/studio.db), which the Node scripts write concurrently.
package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/Faresapn/vireo/backend-go/internal/entity"
)

// SQLite reads personas and videos. It never writes: the Node side owns the
// schema and its migrations.
type SQLite struct {
	db *sql.DB
}

// NewSQLite wraps an open database handle.
func NewSQLite(db *sql.DB) *SQLite {
	return &SQLite{db: db}
}

// personaColumns lists every personas column in entity.Persona order.
const personaColumns = `p.id, p.name, p.niche, p.platform, p.master_prompt, p.character_img, p.aspect,
       p.viral_source, p.viral_cluster_slug, p.archived, p.auto_instruction, p.auto_mode,
       p.auto_engine, p.char_mode, p.audio_mode, p.audio_ref, p.daily_auto, p.daily_auto_last,
       p.daily_auto_status, p.render_res, p.skip_qc, p.drive_folder_id, p.created_at, p.updated_at`

const listPersonasSQL = `
SELECT ` + personaColumns + `,
       COUNT(v.id) FILTER (WHERE v.stage = 'inbox'),
       COUNT(v.id) FILTER (WHERE v.stage = 'shortlist'),
       COUNT(v.id) FILTER (WHERE v.stage IN ('approved', 'generating')),
       COUNT(v.id) FILTER (WHERE v.stage = 'qc'),
       COUNT(v.id) FILTER (WHERE v.stage = 'done')
FROM personas p
LEFT JOIN videos v ON v.persona_id = p.id
GROUP BY p.id
ORDER BY p.archived ASC, p.created_at DESC`

// List returns every persona with its per-stage video counts.
func (r *SQLite) List(ctx context.Context) ([]entity.Persona, error) {
	rows, err := r.db.QueryContext(ctx, listPersonasSQL)
	if err != nil {
		return nil, fmt.Errorf("querying personas: %w", err)
	}
	defer func() { _ = rows.Close() }() // read-only; Err() below reports iteration failures

	var out []entity.Persona

	for rows.Next() {
		var p entity.Persona
		if err := rows.Scan(
			&p.ID, &p.Name, &p.Niche, &p.Platform, &p.MasterPrompt, &p.CharacterImg, &p.Aspect,
			&p.ViralSource, &p.ViralClusterSlug, &p.Archived, &p.AutoInstruction, &p.AutoMode,
			&p.AutoEngine, &p.CharMode, &p.AudioMode, &p.AudioRef, &p.DailyAuto, &p.DailyAutoLast,
			&p.DailyAutoStatus, &p.RenderRes, &p.SkipQC, &p.DriveFolderID, &p.CreatedAt, &p.UpdatedAt,
			&p.Inbox, &p.Shortlist, &p.Generating, &p.QC, &p.Done,
		); err != nil {
			return nil, fmt.Errorf("scanning persona: %w", err)
		}

		out = append(out, p)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterating personas: %w", err)
	}

	if out == nil {
		out = []entity.Persona{} // encode as [] not null
	}

	return out, nil
}

// Exists reports whether a persona with id exists.
func (r *SQLite) Exists(ctx context.Context, id string) (bool, error) {
	var one int

	err := r.db.QueryRowContext(ctx, "SELECT 1 FROM personas WHERE id = ?", id).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}

	if err != nil {
		return false, fmt.Errorf("checking persona: %w", err)
	}

	return true, nil
}

const videoColumns = `id, stage, source_url, local_ref, duration_s, face_count, cut_count,
       ref_score, ref_notes, shortcode, views, views_per_hour, caption, creator,
       prompt_used, idea_summary, master_prompt, hf_request_id, output_480, output_1080,
       qc_status, qc_notes, gen_engine, gen_error, gen_started_at, ingest_order, created_at`

// Videos lists a persona's videos, highest views-per-hour first.
func (r *SQLite) Videos(ctx context.Context, personaID string, f entity.VideoFilter) ([]entity.Video, error) {
	conds := []string{"persona_id = ?"}
	args := []any{personaID}

	if f.Stage != "" {
		conds = append(conds, "stage = ?")
		args = append(args, string(f.Stage))
	}

	if f.Order != "" {
		// Legacy refs (no recorded order) show under both sorts so nothing hides.
		conds = append(conds, "(ingest_order = ? OR ingest_order IS NULL)")
		args = append(args, string(f.Order))
	}
	// Only fixed condition strings are joined; every value is a placeholder.
	//nolint:gosec // G202: constant fragments only
	query := "SELECT " + videoColumns + " FROM videos WHERE " + strings.Join(conds, " AND ") +
		" ORDER BY COALESCE(views_per_hour, 0) DESC, id DESC"

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("querying videos: %w", err)
	}
	defer func() { _ = rows.Close() }() // read-only; Err() below reports iteration failures

	out := []entity.Video{}

	for rows.Next() {
		v, err := scanVideo(rows)
		if err != nil {
			return nil, err
		}

		out = append(out, v)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterating videos: %w", err)
	}

	return out, nil
}

// rowScanner is *sql.Row or *sql.Rows.
type rowScanner interface {
	Scan(dest ...any) error
}

// scanVideo reads one row selected with videoColumns.
func scanVideo(r rowScanner) (entity.Video, error) {
	var v entity.Video
	if err := r.Scan(
		&v.ID, &v.Stage, &v.SourceURL, &v.LocalRef, &v.DurationS, &v.FaceCount, &v.CutCount,
		&v.RefScore, &v.RefNotes, &v.Shortcode, &v.Views, &v.ViewsPerHour, &v.Caption, &v.Creator,
		&v.PromptUsed, &v.IdeaSummary, &v.MasterPrompt, &v.HFRequestID, &v.Output480, &v.Output1080,
		&v.QCStatus, &v.QCNotes, &v.GenEngine, &v.GenError, &v.GenStartedAt, &v.IngestOrder, &v.CreatedAt,
	); err != nil {
		return entity.Video{}, fmt.Errorf("scanning video: %w", err)
	}

	return v, nil
}

// personaFields returns scan targets for personaColumns.
func personaFields(p *entity.Persona) []any {
	return []any{
		&p.ID, &p.Name, &p.Niche, &p.Platform, &p.MasterPrompt, &p.CharacterImg, &p.Aspect,
		&p.ViralSource, &p.ViralClusterSlug, &p.Archived, &p.AutoInstruction, &p.AutoMode,
		&p.AutoEngine, &p.CharMode, &p.AudioMode, &p.AudioRef, &p.DailyAuto, &p.DailyAutoLast,
		&p.DailyAutoStatus, &p.RenderRes, &p.SkipQC, &p.DriveFolderID, &p.CreatedAt, &p.UpdatedAt,
	}
}
