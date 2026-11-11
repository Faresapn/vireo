package persona

import (
	"context"
	"fmt"

	"github.com/Faresapn/vireo/backend-go/internal/entity"
)

// Service answers the dashboard's persona queries.
type Service struct {
	repo Repository
}

// NewService builds a Service on top of repo.
func NewService(repo Repository) *Service {
	return &Service{repo: repo}
}

// List returns every persona, active ones first, newest first.
func (s *Service) List(ctx context.Context) ([]entity.Persona, error) {
	ps, err := s.repo.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("listing personas: %w", err)
	}

	return ps, nil
}

// Videos returns a persona's videos, fastest-growing first. An unknown stage or
// order in f is ignored rather than rejected, as the Node API did.
func (s *Service) Videos(ctx context.Context, personaID string, f entity.VideoFilter) ([]entity.Video, error) {
	ok, err := s.repo.Exists(ctx, personaID)
	if err != nil {
		return nil, fmt.Errorf("looking up persona %q: %w", personaID, err)
	}

	if !ok {
		return nil, entity.ErrPersonaNotFound
	}

	if !f.Order.Valid() {
		f.Order = ""
	}

	vs, err := s.repo.Videos(ctx, personaID, f)
	if err != nil {
		return nil, fmt.Errorf("listing videos of %q: %w", personaID, err)
	}

	return vs, nil
}
