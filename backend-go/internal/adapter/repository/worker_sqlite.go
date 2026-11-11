package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"

	"github.com/Faresapn/vireo/backend-go/internal/entity"
)

// Worker is the read-write store behind the worker commands (ingest, screen,
// prompt, idea, render, auto). It implements the repository ports of those
// use cases. The Node app owns the schema; Worker only reads and updates rows.
type Worker struct {
	db *sql.DB
}

// NewWorker wraps a writable handle.
func NewWorker(db *sql.DB) *Worker { return &Worker{db: db} }

// Persona loads one persona.
func (w *Worker) Persona(ctx context.Context, id string) (entity.Persona, error) {
	var p entity.Persona

	err := w.db.QueryRowContext(ctx, "SELECT "+personaColumns+" FROM personas p WHERE p.id = ?", id).Scan(personaFields(&p)...)
	if errors.Is(err, sql.ErrNoRows) {
		return entity.Persona{}, entity.ErrPersonaNotFound
	}

	if err != nil {
		return entity.Persona{}, fmt.Errorf("loading persona: %w", err)
	}

	return p, nil
}

// Video loads one of the persona's videos.
func (w *Worker) Video(ctx context.Context, personaID string, videoID int64) (entity.Video, error) {
	v, err := scanVideo(w.db.QueryRowContext(ctx,
		"SELECT "+videoColumns+" FROM videos WHERE id = ? AND persona_id = ?", videoID, personaID))
	if errors.Is(err, sql.ErrNoRows) {
		return entity.Video{}, entity.ErrVideoNotFound
	}

	return v, err
}

func (w *Worker) personas(ctx context.Context, where string) ([]entity.Persona, error) {
	rows, err := w.db.QueryContext(ctx, "SELECT "+personaColumns+" FROM personas p WHERE "+where+" ORDER BY p.id") //nolint:gosec // G202: where is a package constant
	if err != nil {
		return nil, fmt.Errorf("querying personas: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var out []entity.Persona

	for rows.Next() {
		var p entity.Persona
		if err := rows.Scan(personaFields(&p)...); err != nil {
			return nil, fmt.Errorf("scanning persona: %w", err)
		}

		out = append(out, p)
	}

	return out, rows.Err()
}

// ClusterPersonas lists active personas wired to a viral cluster.
func (w *Worker) ClusterPersonas(ctx context.Context) ([]entity.Persona, error) {
	return w.personas(ctx, "p.viral_cluster_slug IS NOT NULL AND p.viral_cluster_slug != '' AND COALESCE(p.archived, 0) = 0")
}

// DailyPersonas lists personas with the daily auto toggle on.
func (w *Worker) DailyPersonas(ctx context.Context) ([]entity.Persona, error) {
	return w.personas(ctx, `p.daily_auto = 1 AND COALESCE(p.archived, 0) = 0
		AND COALESCE(p.niche, '') != 'freestyle' AND COALESCE(p.master_prompt, '') != ''`)
}

func (w *Worker) videos(ctx context.Context, where string, args ...any) ([]entity.Video, error) {
	rows, err := w.db.QueryContext(ctx, "SELECT "+videoColumns+" FROM videos WHERE "+where, args...) //nolint:gosec // G202: where is a package constant
	if err != nil {
		return nil, fmt.Errorf("querying videos: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var out []entity.Video

	for rows.Next() {
		v, err := scanVideo(rows)
		if err != nil {
			return nil, err
		}

		out = append(out, v)
	}

	return out, rows.Err()
}

// Inbox lists the persona's inbox videos.
func (w *Worker) Inbox(ctx context.Context, personaID string) ([]entity.Video, error) {
	return w.videos(ctx, "persona_id = ? AND stage = 'inbox'", personaID)
}

// StaleInbox lists inbox videos ingested at least ttlHours ago.
func (w *Worker) StaleInbox(ctx context.Context, personaID string, ttlHours int) ([]entity.Video, error) {
	return w.videos(ctx, `persona_id = ? AND stage = 'inbox' AND ingested_at IS NOT NULL
		AND ingested_at <= datetime('now', ?)`, personaID, "-"+strconv.Itoa(ttlHours)+" hours")
}

func (w *Worker) count(ctx context.Context, query string, args ...any) (int, error) {
	var n int
	if err := w.db.QueryRowContext(ctx, query, args...).Scan(&n); err != nil {
		return 0, fmt.Errorf("counting: %w", err)
	}

	return n, nil
}

// CountVideos counts all of the persona's videos.
func (w *Worker) CountVideos(ctx context.Context, personaID string) (int, error) {
	return w.count(ctx, "SELECT COUNT(*) FROM videos WHERE persona_id = ?", personaID)
}

// InboxCount counts the persona's inbox videos.
func (w *Worker) InboxCount(ctx context.Context, personaID string) (int, error) {
	return w.count(ctx, "SELECT COUNT(*) FROM videos WHERE persona_id = ? AND stage = 'inbox'", personaID)
}

// OKDurationStats is the average duration and count of OK decisions in a niche.
func (w *Worker) OKDurationStats(ctx context.Context, niche string) (float64, int, error) {
	var (
		avg sql.NullFloat64
		n   int
	)

	err := w.db.QueryRowContext(ctx, `SELECT AVG(duration_s), COUNT(*) FROM decisions
		WHERE niche = ? AND verdict = 'ok' AND duration_s IS NOT NULL`, niche).Scan(&avg, &n)
	if err != nil {
		return 0, 0, fmt.Errorf("decision stats: %w", err)
	}

	return avg.Float64, n, nil
}

// Shortcodes returns the persona's known shortcodes.
func (w *Worker) Shortcodes(ctx context.Context, personaID string) (map[string]bool, error) {
	rows, err := w.db.QueryContext(ctx, "SELECT shortcode FROM videos WHERE persona_id = ? AND shortcode IS NOT NULL", personaID)
	if err != nil {
		return nil, fmt.Errorf("querying shortcodes: %w", err)
	}
	defer func() { _ = rows.Close() }()

	out := map[string]bool{}

	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return nil, fmt.Errorf("scanning shortcode: %w", err)
		}

		out[s] = true
	}

	return out, rows.Err()
}

// InsertRef adds an ingested reference to the inbox.
func (w *Worker) InsertRef(ctx context.Context, r entity.NewRef) error {
	_, err := w.db.ExecContext(ctx, `INSERT INTO videos
		(persona_id, stage, source_url, local_ref, duration_s, shortcode, views, views_per_hour, caption, creator, ingest_order, ingested_at)
		VALUES (?, 'inbox', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
		r.PersonaID, r.SourceURL, r.LocalRef, r.DurationS, r.Shortcode, r.Views, r.ViewsPerHour, r.Caption, r.Creator, string(r.IngestOrder))
	if err != nil {
		return fmt.Errorf("inserting ref: %w", err)
	}

	return nil
}

// DeleteVideo removes a video row.
func (w *Worker) DeleteVideo(ctx context.Context, id int64) error {
	return w.exec(ctx, "DELETE FROM videos WHERE id = ?", id)
}

func (w *Worker) exec(ctx context.Context, query string, args ...any) error {
	if _, err := w.db.ExecContext(ctx, query, args...); err != nil {
		return fmt.Errorf("updating: %w", err)
	}

	return nil
}

// SaveScreen stores a reference's suitability score.
func (w *Worker) SaveScreen(ctx context.Context, videoID int64, score int, notes string) error {
	return w.exec(ctx, "UPDATE videos SET ref_score = ?, ref_notes = ?, updated_at = datetime('now') WHERE id = ?", score, notes, videoID)
}

// SavePrompt stores the prompt a render will use.
func (w *Worker) SavePrompt(ctx context.Context, videoID int64, prompt string) error {
	return w.exec(ctx, "UPDATE videos SET prompt_used = ?, updated_at = datetime('now') WHERE id = ?", prompt, videoID)
}

// IdeaVectors lists the persona's stored ideas, newest first.
func (w *Worker) IdeaVectors(ctx context.Context, personaID string) ([]entity.IdeaVector, error) {
	rows, err := w.db.QueryContext(ctx, "SELECT summary, vector FROM idea_vectors WHERE persona_id = ? ORDER BY created_at DESC", personaID)
	if err != nil {
		return nil, fmt.Errorf("querying ideas: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var out []entity.IdeaVector

	for rows.Next() {
		var (
			iv  entity.IdeaVector
			raw string
		)
		if err := rows.Scan(&iv.Summary, &raw); err != nil {
			return nil, fmt.Errorf("scanning idea: %w", err)
		}

		_ = json.Unmarshal([]byte(raw), &iv.Vector) // a corrupt vector just isn't compared
		out = append(out, iv)
	}

	return out, rows.Err()
}

// InsertIdea creates the shortlist draft and its embedding in one transaction.
func (w *Worker) InsertIdea(ctx context.Context, personaID, shortcode, prompt, summary string, vector []float64) (int64, error) {
	vec, err := json.Marshal(vector)
	if err != nil {
		return 0, fmt.Errorf("encoding vector: %w", err)
	}

	tx, err := w.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("begin: %w", err)
	}

	defer func() { _ = tx.Rollback() }()

	res, err := tx.ExecContext(ctx, `INSERT INTO videos (persona_id, shortcode, stage, prompt_used, idea_summary, created_at, updated_at)
		VALUES (?, ?, 'shortlist', ?, ?, datetime('now'), datetime('now'))`, personaID, shortcode, prompt, summary)
	if err != nil {
		return 0, fmt.Errorf("inserting idea video: %w", err)
	}

	id, err := res.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("idea video id: %w", err)
	}

	if _, err := tx.ExecContext(ctx, `INSERT INTO idea_vectors (persona_id, video_id, summary, vector, created_at)
		VALUES (?, ?, ?, ?, datetime('now'))`, personaID, id, summary, string(vec)); err != nil {
		return 0, fmt.Errorf("inserting idea vector: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit: %w", err)
	}

	return id, nil
}

func (w *Worker) relPaths(ctx context.Context, query string, args ...any) ([]string, error) {
	rows, err := w.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("querying character images: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var out []string

	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, fmt.Errorf("scanning character image: %w", err)
		}

		out = append(out, p)
	}

	return out, rows.Err()
}

// PersonaImages are the persona-wide character images, in order.
func (w *Worker) PersonaImages(ctx context.Context, personaID string) ([]string, error) {
	return w.relPaths(ctx, "SELECT rel_path FROM character_images WHERE persona_id = ? AND video_id IS NULL ORDER BY ord ASC, id ASC", personaID)
}

// CharacterImages are the video's own images (freestyle), else the persona's.
func (w *Worker) CharacterImages(ctx context.Context, personaID string, videoID int64) ([]string, error) {
	own, err := w.relPaths(ctx, "SELECT rel_path FROM character_images WHERE video_id = ? ORDER BY ord ASC, id ASC", videoID)
	if err != nil || len(own) > 0 {
		return own, err
	}

	return w.PersonaImages(ctx, personaID)
}

// SetRequestID stores the Higgsfield request id right after submit, so a
// poll timeout can be recovered without paying again.
func (w *Worker) SetRequestID(ctx context.Context, videoID int64, requestID string) error {
	return w.exec(ctx, "UPDATE videos SET hf_request_id = ?, updated_at = datetime('now') WHERE id = ?", requestID, videoID)
}

// FailRender moves a video back to the shortlist with an error.
func (w *Worker) FailRender(ctx context.Context, videoID int64, msg string) error {
	return w.exec(ctx, "UPDATE videos SET stage = 'shortlist', gen_error = ?, updated_at = datetime('now') WHERE id = ?", truncate(msg, 200), videoID)
}

// FinishRender records a downloaded render.
func (w *Worker) FinishRender(ctx context.Context, d entity.RenderDone) error {
	var qc any
	if d.Stage == entity.StageDone {
		qc = "ok"
	}

	col := "output_1080"
	if d.Column == "output_480" {
		col = "output_480"
	}

	q := "UPDATE videos SET " + col + " = ?, stage = ?, qc_status = ?, updated_at = datetime('now')"

	args := []any{d.OutputRel, string(d.Stage), qc}
	if d.Prompt != nil {
		q += ", prompt_used = ?"

		args = append(args, *d.Prompt)
	}

	if d.RequestID != nil {
		q += ", hf_request_id = ?"

		args = append(args, *d.RequestID)
	}

	if d.ClearError {
		q += ", gen_error = NULL"
	}

	args = append(args, d.VideoID)

	return w.exec(ctx, q+" WHERE id = ?", args...)
}

// SetStage moves a video to stage.
func (w *Worker) SetStage(ctx context.Context, videoID int64, stage entity.Stage) error {
	return w.exec(ctx, "UPDATE videos SET stage = ?, updated_at = datetime('now') WHERE id = ?", string(stage), videoID)
}

// PenalizeRef returns a failed ref to the inbox with score at most 20, so the
// picker won't choose it again.
func (w *Worker) PenalizeRef(ctx context.Context, videoID int64) error {
	return w.exec(ctx, `UPDATE videos SET stage = 'inbox', ref_score = MIN(COALESCE(ref_score, 50), 20),
		updated_at = datetime('now') WHERE id = ?`, videoID)
}

// MarkDone marks a video QC-approved.
func (w *Worker) MarkDone(ctx context.Context, videoID int64) error {
	return w.exec(ctx, "UPDATE videos SET stage = 'done', qc_status = 'ok', updated_at = datetime('now') WHERE id = ?", videoID)
}

// StartRender marks a video as rendering on engine.
func (w *Worker) StartRender(ctx context.Context, videoID int64, engine entity.Engine) error {
	return w.exec(ctx, `UPDATE videos SET stage = 'generating', gen_engine = ?, gen_error = NULL,
		gen_started_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`, string(engine), videoID)
}

// ResetStuckRender moves a video still marked generating back to the
// shortlist, keeping an existing error, and returns the error text.
func (w *Worker) ResetStuckRender(ctx context.Context, videoID int64, fallback string) (string, error) {
	if err := w.exec(ctx, `UPDATE videos SET stage = 'shortlist', gen_error = COALESCE(gen_error, ?),
		updated_at = datetime('now') WHERE id = ? AND stage = 'generating'`, fallback, videoID); err != nil {
		return "", err
	}

	var msg sql.NullString
	if err := w.db.QueryRowContext(ctx, "SELECT gen_error FROM videos WHERE id = ?", videoID).Scan(&msg); err != nil {
		return "", fmt.Errorf("reading gen_error: %w", err)
	}

	if msg.String == "" {
		return "generate gagal", nil
	}

	return msg.String, nil
}

// RAGStats counts first-try QC outcomes of a niche.
func (w *Worker) RAGStats(ctx context.Context, niche string) (entity.RAGStats, error) {
	var ok, tries sql.NullInt64

	err := w.db.QueryRowContext(ctx, `SELECT SUM(CASE WHEN verdict = 'ok' AND first_try = 1 THEN 1 ELSE 0 END),
		SUM(CASE WHEN first_try = 1 THEN 1 ELSE 0 END) FROM decisions WHERE niche = ?`, niche).Scan(&ok, &tries)
	if err != nil {
		return entity.RAGStats{}, fmt.Errorf("rag stats: %w", err)
	}

	return entity.RAGStats{FirstTryOK: int(ok.Int64), FirstTries: int(tries.Int64)}, nil
}

// BestEngine is the engine with the best OK rate in a niche (ignoring
// seedance-2.5), or "" with no history.
func (w *Worker) BestEngine(ctx context.Context, niche string) (entity.Engine, error) {
	var e string

	err := w.db.QueryRowContext(ctx, `SELECT engine FROM decisions
		WHERE niche = ? AND engine IS NOT NULL AND engine != 'seedance-2.5'
		GROUP BY engine ORDER BY SUM(CASE WHEN verdict = 'ok' THEN 1 ELSE 0 END) * 1.0 / COUNT(*) DESC, COUNT(*) DESC
		LIMIT 1`, niche).Scan(&e)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}

	if err != nil {
		return "", fmt.Errorf("best engine: %w", err)
	}

	return entity.Engine(e), nil
}

// VideoStage reads a video's stage.
func (w *Worker) VideoStage(ctx context.Context, videoID int64) (entity.Stage, error) {
	var s string
	if err := w.db.QueryRowContext(ctx, "SELECT stage FROM videos WHERE id = ?", videoID).Scan(&s); err != nil {
		return "", fmt.Errorf("reading stage: %w", err)
	}

	return entity.Stage(s), nil
}

// SetDailyLast records the local date the daily auto ran a persona.
func (w *Worker) SetDailyLast(ctx context.Context, personaID, date string) error {
	return w.exec(ctx, "UPDATE personas SET daily_auto_last = ? WHERE id = ?", date, personaID)
}

// SetDailyStatus records the daily auto's last status line.
func (w *Worker) SetDailyStatus(ctx context.Context, personaID, status string) error {
	return w.exec(ctx, "UPDATE personas SET daily_auto_status = ? WHERE id = ?", status, personaID)
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}

	return string(r[:n])
}
