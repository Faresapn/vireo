package handler

import (
	"context"
	"errors"
	"net/http"

	"github.com/Faresapn/vireo/backend-go/internal/entity"
)

// PersonaService is what the persona handler needs from the use case layer.
type PersonaService interface {
	List(ctx context.Context) ([]entity.Persona, error)
	Videos(ctx context.Context, personaID string, f entity.VideoFilter) ([]entity.Video, error)
}

// Persona serves /api/personas.
type Persona struct {
	svc PersonaService
}

// NewPersona builds the handler.
func NewPersona(svc PersonaService) *Persona {
	return &Persona{svc: svc}
}

// List handles GET /api/personas.
func (h *Persona) List(w http.ResponseWriter, r *http.Request) {
	ps, err := h.svc.List(r.Context())
	if err != nil {
		internalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, ps)
}

// Videos handles GET /api/personas/{id}/videos?stage=&order=.
func (h *Persona) Videos(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()

	f := entity.VideoFilter{
		Stage: entity.Stage(q.Get("stage")),
		Order: entity.IngestOrder(q.Get("order")),
	}
	if f.Stage != "" && !f.Stage.Valid() {
		writeError(w, http.StatusBadRequest, "stage tidak dikenal")
		return
	}

	vs, err := h.svc.Videos(r.Context(), r.PathValue("id"), f)
	if errors.Is(err, entity.ErrPersonaNotFound) {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}

	if err != nil {
		internalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, vs)
}
