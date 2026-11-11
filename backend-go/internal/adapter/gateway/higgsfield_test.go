package gateway_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Faresapn/vireo/backend-go/internal/adapter/gateway"
	"github.com/Faresapn/vireo/backend-go/internal/entity"
)

func TestCheck(t *testing.T) {
	t.Parallel()

	tests := []struct {
		code int
		want entity.KeyStatus
	}{
		{http.StatusNotFound, entity.KeyValid},
		{http.StatusOK, entity.KeyValid},
		{http.StatusUnauthorized, entity.KeyInvalid},
		{http.StatusForbidden, entity.KeyInvalid},
		{http.StatusInternalServerError, entity.KeyUnknown},
	}
	for _, tt := range tests {
		t.Run(http.StatusText(tt.code), func(t *testing.T) {
			t.Parallel()

			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if got := r.Header.Get("Authorization"); got != "Key k:s" {
					t.Errorf("Authorization = %q", got)
				}

				w.WriteHeader(tt.code)
			}))
			defer srv.Close()

			hf := gateway.NewHiggsfield(srv.Client()).WithURL(srv.URL)
			if got := hf.Check(context.Background(), "k:s"); got != tt.want {
				t.Fatalf("Check() with HTTP %d = %s, want %s", tt.code, got, tt.want)
			}
		})
	}
}

func TestCheckNetworkErrorIsUnknown(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL
	srv.Close() // nothing listens any more

	if got := gateway.NewHiggsfield(nil).WithURL(url).Check(context.Background(), "k:s"); got != entity.KeyUnknown {
		t.Fatalf("Check() = %s, want unknown", got)
	}
}
