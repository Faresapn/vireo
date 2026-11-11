package infrastructure

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/Faresapn/vireo/backend-go/internal/adapter/handler"
)

// NewRouter maps routes to handlers using the Go 1.22+ pattern syntax.
func NewRouter(personas *handler.Persona, settings *handler.Settings) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("GET /api/personas", personas.List)
	mux.HandleFunc("GET /api/personas/{id}/videos", personas.Videos)
	mux.HandleFunc("GET /api/settings/keys", settings.ListKeys)
	mux.HandleFunc("POST /api/settings/keys", settings.SaveKey)

	return logRequests(mux)
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// logRequests writes one structured log line per request.
func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		slog.InfoContext(r.Context(), "http",
			"method", r.Method, "path", r.URL.Path, "status", rec.status,
			"dur_ms", time.Since(start).Milliseconds())
	})
}
