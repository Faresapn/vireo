package archive

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"time"

	"github.com/Faresapn/vireo/backend-go/internal/entity"
)

// baseDir is the Drive folder that holds personas without their own folder.
const baseDir = "HiggsfieldStudio"

// ErrOutputMissing is returned when a persona with its own folder has no
// rendered output file on disk.
var ErrOutputMissing = errors.New("output file not found")

// Result is what an archive run uploaded. It encodes to the same JSON the Node
// script printed.
type Result struct {
	OK       bool     `json:"ok"`
	Folder   string   `json:"folder,omitempty"`
	Slug     string   `json:"slug,omitempty"`
	Uploaded []string `json:"uploaded"`
	DryRun   bool     `json:"dry_run,omitempty"`
}

// Service archives videos.
type Service struct {
	repo        Repository
	uploader    Uploader
	files       Files
	personasDir string
	now         func() time.Time
}

// NewService builds a Service. personasDir is the studio's personas/ folder.
func NewService(repo Repository, uploader Uploader, files Files, personasDir string, now func() time.Time) *Service {
	if now == nil {
		now = time.Now
	}

	return &Service{repo: repo, uploader: uploader, files: files, personasDir: personasDir, now: now}
}

// Archive uploads a video. With dryRun it computes the same plan but neither
// uploads nor writes to the database.
func (s *Service) Archive(ctx context.Context, personaID string, videoID int64, dryRun bool) (Result, error) {
	p, err := s.repo.Persona(ctx, personaID)
	if err != nil {
		return Result{}, err
	}

	v, err := s.repo.Video(ctx, personaID, videoID)
	if err != nil {
		return Result{}, err
	}

	if p.DriveFolderID != nil && *p.DriveFolderID != "" {
		return s.toPersonaFolder(ctx, p, v, dryRun)
	}

	return s.toStudioTree(ctx, p, v, dryRun)
}

func (s *Service) toPersonaFolder(ctx context.Context, p Persona, v Video, dryRun bool) (Result, error) {
	local, ok := s.output(p.ID, v)
	if !ok {
		return Result{}, ErrOutputMissing
	}

	name, err := s.driveName(ctx, p, v)
	if err != nil {
		return Result{}, err
	}

	res := Result{OK: true, Folder: *p.DriveFolderID, Uploaded: []string{name}, DryRun: dryRun}
	if dryRun {
		return res, nil
	}

	if err := s.uploader.Copy(ctx, local, name, *p.DriveFolderID); err != nil {
		return Result{}, fmt.Errorf("uploading %s: %w", name, err)
	}

	if err := s.repo.MarkSynced(ctx, v.ID, &name); err != nil {
		return Result{}, fmt.Errorf("marking video %d synced: %w", v.ID, err)
	}

	return res, nil
}

// upload is one planned file copy into the studio tree.
type upload struct{ local, remote, label string }

func (s *Service) toStudioTree(ctx context.Context, p Persona, v Video, dryRun bool) (Result, error) {
	slug := p.ID
	if p.ViralClusterSlug != nil && *p.ViralClusterSlug != "" {
		slug = *p.ViralClusterSlug
	}

	res := Result{OK: true, Slug: slug, Uploaded: []string{}, DryRun: dryRun}
	for _, u := range s.studioPlan(slug, p.ID, v) {
		if !dryRun {
			if err := s.uploader.Copy(ctx, u.local, u.remote, ""); err != nil {
				return Result{}, fmt.Errorf("uploading %s: %w", u.label, err)
			}
		}

		res.Uploaded = append(res.Uploaded, u.label)
	}

	if dryRun {
		return res, nil
	}

	if err := s.repo.MarkSynced(ctx, v.ID, nil); err != nil {
		return Result{}, fmt.Errorf("marking video %d synced: %w", v.ID, err)
	}

	return res, nil
}

// studioPlan lists the output (1080p, else 480p) and the reference, each only
// if it exists on disk.
func (s *Service) studioPlan(slug, personaID string, v Video) []upload {
	var plan []upload

	if local, ok := s.output(personaID, v); ok {
		res := "480p"
		if v.Output1080 != nil && *v.Output1080 != "" {
			res = "1080p"
		}

		name := filepath.Base(local)
		plan = append(plan, upload{local, fmt.Sprintf("%s/%s/output/%s/%s", baseDir, slug, res, name), "output/" + res + "/" + name})
	}

	if v.LocalRef != nil && *v.LocalRef != "" {
		local := filepath.Join(s.personasDir, personaID, *v.LocalRef)
		if s.files.Exists(local) {
			name := filepath.Base(local)
			plan = append(plan, upload{local, fmt.Sprintf("%s/%s/references/%s", baseDir, slug, name), "references/" + name})
		}
	}

	return plan
}

// output returns the 1080p file, else the 480p one, if it exists on disk.
func (s *Service) output(personaID string, v Video) (string, bool) {
	rel := v.Output1080
	if rel == nil || *rel == "" {
		rel = v.Output480
	}

	if rel == nil || *rel == "" {
		return "", false
	}

	local := filepath.Join(s.personasDir, personaID, *rel)

	return local, s.files.Exists(local)
}

// driveName keeps a name given on an earlier run, so a re-archive overwrites
// the same file instead of creating a new batch number.
func (s *Service) driveName(ctx context.Context, p Persona, v Video) (string, error) {
	if v.DriveName != nil && *v.DriveName != "" {
		return *v.DriveName, nil
	}

	prefix := entity.DriveNamePrefix(s.now(), entity.DriveLabel(p.Name, p.ID))

	used, err := s.repo.DriveNames(ctx, p.ID, prefix)
	if err != nil {
		return "", fmt.Errorf("listing used drive names: %w", err)
	}

	return entity.NextDriveName(prefix, used), nil
}
