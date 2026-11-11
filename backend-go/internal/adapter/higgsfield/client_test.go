package higgsfield_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Faresapn/vireo/backend-go/internal/adapter/higgsfield"
)

func fast() *higgsfield.Client {
	return &higgsfield.Client{PollEvery: time.Millisecond, RetryDelay: time.Millisecond, PollTries: 20}
}

func TestSubmitReusesIdempotencyKeyAcrossRetries(t *testing.T) {
	t.Parallel()

	var (
		mu    sync.Mutex
		keys  []string
		calls atomic.Int32
	)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()

		keys = append(keys, r.Header.Get("Idempotency-Key"))
		mu.Unlock()

		if calls.Add(1) == 1 {
			hj, _ := w.(http.Hijacker)
			conn, _, _ := hj.Hijack()
			_ = conn.Close() // network error on the first try

			return
		}

		if r.Header.Get("Authorization") != "Key k:s" {
			t.Errorf("auth = %q", r.Header.Get("Authorization"))
		}

		_, _ = w.Write([]byte(`{"request_id":"r1","status_url":"u"}`))
	}))
	defer srv.Close()

	sub, err := fast().Submit(context.Background(), srv.URL, "k:s", "gen", map[string]any{"a": 1})
	if err != nil || sub.RequestID != "r1" {
		t.Fatalf("Submit = %+v, %v", sub, err)
	}

	if len(keys) != 2 || keys[0] != keys[1] || keys[0] == "" {
		t.Fatalf("idempotency keys = %v, want the same key twice", keys)
	}
}

func TestPoll(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		statuses []string
		wantErr  string
	}{
		{"completes", []string{`{"status":"queued"}`, `{"status":"in_progress"}`, `{"status":"completed","video":{"url":"v"}}`}, ""},
		{"nsfw", []string{`{"status":"nsfw","error":"content safety"}`}, "nsfw: content safety"},
		{"timeout", []string{`{"status":"queued"}`}, "poll timeout"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			var i atomic.Int32

			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				n := int(i.Add(1)) - 1
				_, _ = w.Write([]byte(tt.statuses[min(n, len(tt.statuses)-1)]))
			}))
			defer srv.Close()

			st, err := fast().Poll(context.Background(), srv.URL, "k")
			if tt.wantErr == "" {
				if err != nil || st.Video == nil || st.Video.URL != "v" {
					t.Fatalf("Poll = %+v, %v", st, err)
				}

				return
			}

			if err == nil || err.Error() != tt.wantErr {
				t.Fatalf("err = %v, want %q", err, tt.wantErr)
			}
		})
	}
}

func TestPollGivesUpAfterRepeatedNetworkErrors(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL
	srv.Close()

	_, err := fast().Poll(context.Background(), url, "k")
	if err == nil || errors.Is(err, higgsfield.ErrPollTimeout) {
		t.Fatalf("err = %v, want a network failure", err)
	}
}
