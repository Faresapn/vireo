package handler_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Faresapn/vireo/backend-go/internal/adapter/handler"
	"github.com/Faresapn/vireo/backend-go/internal/entity"
	"github.com/Faresapn/vireo/backend-go/internal/infrastructure"
)

type fakePersonas struct{}

func (*fakePersonas) List(context.Context) ([]entity.Persona, error) {
	return []entity.Persona{{ID: "denvo", Name: "Denvo"}}, nil
}

func (*fakePersonas) Videos(_ context.Context, id string, _ entity.VideoFilter) ([]entity.Video, error) {
	if id != "denvo" {
		return nil, entity.ErrPersonaNotFound
	}

	return []entity.Video{{ID: 7, Stage: entity.StageQC}}, nil
}

type fakeKeys struct{}

func (fakeKeys) List(context.Context, bool) ([]entity.KeyInfo, error) { return nil, nil }
func (fakeKeys) Save(_ context.Context, slot entity.KeySlot, raw string) (entity.KeyInfo, error) {
	if raw == "bad" {
		return entity.KeyInfo{}, entity.ErrKeyFormat
	}

	return entity.KeyInfo{Slot: slot, Set: true, Status: entity.KeyValid}, nil
}

func TestRoutes(t *testing.T) {
	t.Parallel()

	personas := &fakePersonas{}
	router := infrastructure.NewRouter(handler.NewPersona(personas), handler.NewSettings(fakeKeys{}))

	tests := []struct {
		name, method, path, body string
		wantCode                 int
		wantBody                 string
	}{
		{"list personas", http.MethodGet, "/api/personas", "", 200, `"id":"denvo"`},
		{"videos", http.MethodGet, "/api/personas/denvo/videos?stage=qc&order=date", "", 200, `"stage":"qc"`},
		{"unknown persona", http.MethodGet, "/api/personas/ghost/videos", "", 404, `persona not found`},
		{"unknown stage", http.MethodGet, "/api/personas/denvo/videos?stage=lol", "", 400, `stage tidak dikenal`},
		{"save key", http.MethodPost, "/api/settings/keys", `{"slot":"wan","key":"good"}`, 200, `"ok":true`},
		{"bad key format", http.MethodPost, "/api/settings/keys", `{"slot":"wan","key":"bad"}`, 400, `format key salah`},
		{"non-JSON body", http.MethodPost, "/api/settings/keys", `slot=wan`, 400, `body harus JSON`},
		{"wrong method", http.MethodDelete, "/api/personas", "", 405, ``},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			req := httptest.NewRequestWithContext(t.Context(), tt.method, tt.path, strings.NewReader(tt.body))
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)

			if rec.Code != tt.wantCode {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, tt.wantCode, rec.Body)
			}

			if !strings.Contains(rec.Body.String(), tt.wantBody) {
				t.Fatalf("body %s does not contain %s", rec.Body, tt.wantBody)
			}
		})
	}
}

func TestPersonaJSONMatchesNodeShape(t *testing.T) {
	t.Parallel()

	res := "480p"

	b, err := json.Marshal(entity.Persona{ID: "x", RenderRes: &res, QC: 2})
	if err != nil {
		t.Fatal(err)
	}

	for _, want := range []string{`"render_res":"480p"`, `"cnt_qc":2`, `"master_prompt":null`} {
		if !strings.Contains(string(b), want) {
			t.Fatalf("%s missing %s", b, want)
		}
	}
}
