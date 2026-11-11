// Package render runs paid Higgsfield renders: motion transfer from a
// reference video (Generate), image-only Seedance (GenerateI2V), and picking
// up a render whose poll gave up (Recover, which never submits again).
package render

import (
	"context"

	"github.com/Faresapn/vireo/backend-go/internal/adapter/higgsfield"
	"github.com/Faresapn/vireo/backend-go/internal/entity"
)

// Repository is the storage renders need.
type Repository interface {
	Persona(ctx context.Context, id string) (entity.Persona, error)
	Video(ctx context.Context, personaID string, videoID int64) (entity.Video, error)
	CharacterImages(ctx context.Context, personaID string, videoID int64) ([]string, error)
	PersonaImages(ctx context.Context, personaID string) ([]string, error)
	SetRequestID(ctx context.Context, videoID int64, requestID string) error
	FailRender(ctx context.Context, videoID int64, msg string) error
	FinishRender(ctx context.Context, d entity.RenderDone) error
}

// Transit makes local files reachable by URL for the duration of a render.
type Transit interface {
	Upload(ctx context.Context, local, name string) (string, error)
	Delete(ctx context.Context, name string)
}

// Media prepares inputs.
type Media interface {
	PrepareRef(ctx context.Context, src string, logf func(string, ...any)) (string, bool)
	DownscaleImage(ctx context.Context, src string, maxPx int, logf func(string, ...any)) (string, bool)
	VideoSeconds(ctx context.Context, path string) float64
}

// Higgsfield submits, polls and downloads.
type Higgsfield interface {
	Submit(ctx context.Context, endpoint, key, idemPrefix string, body any) (higgsfield.Submission, error)
	Poll(ctx context.Context, statusURL, key string) (higgsfield.Status, error)
	GetStatus(ctx context.Context, statusURL, key string) (higgsfield.Status, error)
	Download(ctx context.Context, url string) ([]byte, error)
}

// Keys returns the API key of a slot ("" when unset).
type Keys interface {
	Key(slot entity.KeySlot) string
}

// Archiver uploads a finished video to Drive.
type Archiver interface {
	Archive(ctx context.Context, personaID string, videoID int64) error
}
