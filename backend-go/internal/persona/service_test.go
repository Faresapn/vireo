package persona_test

import (
	"context"
	"errors"
	"testing"

	"github.com/Faresapn/vireo/backend-go/internal/entity"
	"github.com/Faresapn/vireo/backend-go/internal/persona"
)

type fakeRepo struct {
	exists    bool
	gotFilter entity.VideoFilter
	err       error
}

func (f *fakeRepo) List(context.Context) ([]entity.Persona, error) { return nil, f.err }
func (f *fakeRepo) Exists(context.Context, string) (bool, error)   { return f.exists, f.err }
func (f *fakeRepo) Videos(_ context.Context, _ string, flt entity.VideoFilter) ([]entity.Video, error) {
	f.gotFilter = flt
	return []entity.Video{}, nil
}

func TestVideos(t *testing.T) {
	t.Parallel()

	dbErr := errors.New("disk on fire")

	tests := []struct {
		name      string
		repo      *fakeRepo
		filter    entity.VideoFilter
		wantErr   error
		wantOrder entity.IngestOrder
	}{
		{"known persona", &fakeRepo{exists: true}, entity.VideoFilter{Order: entity.OrderDate}, nil, entity.OrderDate},
		{"unknown order is dropped", &fakeRepo{exists: true}, entity.VideoFilter{Order: "random"}, nil, ""},
		{"missing persona", &fakeRepo{}, entity.VideoFilter{}, entity.ErrPersonaNotFound, ""},
		{"storage error is wrapped", &fakeRepo{err: dbErr}, entity.VideoFilter{}, dbErr, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			_, err := persona.NewService(tt.repo).Videos(context.Background(), "denvo", tt.filter)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("Videos() error = %v, want %v", err, tt.wantErr)
			}

			if err == nil && tt.repo.gotFilter.Order != tt.wantOrder {
				t.Fatalf("order passed to repo = %q, want %q", tt.repo.gotFilter.Order, tt.wantOrder)
			}
		})
	}
}
