// Package archive uploads finished videos to Google Drive.
//
// A persona with its own Drive folder gets only the output there, named
// DD-MM-YYYY_<persona>_<n>.mp4 (n = that persona's batch number for the day).
// Other personas get the output and the reference under
// HiggsfieldStudio/<slug>/ in the remote's root.
package archive

import "context"

// Persona is the part of a persona the archiver needs.
type Persona struct {
	ID               string
	Name             string
	ViralClusterSlug *string
	DriveFolderID    *string
}

// Video is the part of a video the archiver needs. Paths are relative to the
// persona's directory.
type Video struct {
	ID         int64
	LocalRef   *string
	Output480  *string
	Output1080 *string
	DriveName  *string
}

// Repository loads archive inputs and records the result.
type Repository interface {
	Persona(ctx context.Context, id string) (Persona, error)
	Video(ctx context.Context, personaID string, videoID int64) (Video, error)
	// DriveNames returns the persona's drive_name values that start with prefix.
	DriveNames(ctx context.Context, personaID, prefix string) ([]string, error)
	// MarkSynced sets drive_synced=1, and drive_name when name is not nil.
	MarkSynced(ctx context.Context, videoID int64, name *string) error
}

// Uploader copies one local file to a remote path. folderID, when not empty,
// makes the path relative to that Drive folder instead of the remote's root.
type Uploader interface {
	Copy(ctx context.Context, localPath, remotePath, folderID string) error
}

// Files answers whether a local file exists.
type Files interface {
	Exists(path string) bool
}
