// Package persona holds the read use cases for personas and their videos.
package persona

import (
	"context"

	"github.com/Faresapn/vireo/backend-go/internal/entity"
)

// Repository is the storage the persona use cases need. The SQLite adapter
// implements it; tests use an in-memory fake.
type Repository interface {
	List(ctx context.Context) ([]entity.Persona, error)
	Exists(ctx context.Context, id string) (bool, error)
	Videos(ctx context.Context, personaID string, f entity.VideoFilter) ([]entity.Video, error)
}
