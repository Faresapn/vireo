package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/Faresapn/vireo/backend-go/internal/entity"
)

// KeyService is what the settings handler needs from the use case layer.
type KeyService interface {
	List(ctx context.Context, check bool) ([]entity.KeyInfo, error)
	Save(ctx context.Context, slot entity.KeySlot, raw string) (entity.KeyInfo, error)
}

// Settings serves /api/settings/keys.
type Settings struct {
	svc KeyService
}

// NewSettings builds the handler.
func NewSettings(svc KeyService) *Settings {
	return &Settings{svc: svc}
}

// ListKeys handles GET /api/settings/keys?check=1.
func (h *Settings) ListKeys(w http.ResponseWriter, r *http.Request) {
	keys, err := h.svc.List(r.Context(), r.URL.Query().Get("check") == "1")
	if err != nil {
		internalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"keys": keys})
}

type saveKeyRequest struct {
	Slot entity.KeySlot `json:"slot"`
	Key  string         `json:"key"`
}

// SaveKey handles POST /api/settings/keys {"slot": "wan"|"seedance", "key": "..."}.
func (h *Settings) SaveKey(w http.ResponseWriter, r *http.Request) {
	var body saveKeyRequest

	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10))
	if err := dec.Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "body harus JSON {slot, key}")
		return
	}

	info, err := h.svc.Save(r.Context(), body.Slot, body.Key)
	switch {
	case errors.Is(err, entity.ErrUnknownSlot),
		errors.Is(err, entity.ErrKeyFormat),
		errors.Is(err, entity.ErrKeyRejected):
		writeError(w, http.StatusBadRequest, err.Error())
		return
	case err != nil:
		internalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "status": info.Status, "key": info})
}
