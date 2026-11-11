// Package gateway talks to external services.
package gateway

import (
	"context"
	"io"
	"net/http"
	"time"

	"github.com/Faresapn/vireo/backend-go/internal/entity"
)

// probeURL is the status endpoint of a request id that never exists. Higgsfield
// answers 404 for a good key and 401/403 for a bad one, and charges nothing.
const probeURL = "https://api.higgsfield.ai/requests/00000000-0000-0000-0000-000000000000/status"

// Higgsfield checks API keys against the Higgsfield API.
type Higgsfield struct {
	client *http.Client
	url    string
}

// NewHiggsfield returns a checker. A nil client gets a 10-second timeout.
func NewHiggsfield(client *http.Client) *Higgsfield {
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}

	return &Higgsfield{client: client, url: probeURL}
}

// WithURL points the checker at another endpoint (for tests).
func (h *Higgsfield) WithURL(u string) *Higgsfield {
	c := *h
	c.url = u

	return &c
}

// Check reports whether Higgsfield accepts key.
func (h *Higgsfield) Check(ctx context.Context, key entity.APIKey) entity.KeyStatus {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.url, nil)
	if err != nil {
		return entity.KeyUnknown
	}

	req.Header.Set("Authorization", "Key "+string(key))

	resp, err := h.client.Do(req)
	if err != nil {
		return entity.KeyUnknown
	}
	defer func() { _ = resp.Body.Close() }()

	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10)) // let the connection be reused

	switch {
	case resp.StatusCode == http.StatusUnauthorized, resp.StatusCode == http.StatusForbidden:
		return entity.KeyInvalid
	case resp.StatusCode == http.StatusNotFound, resp.StatusCode < 300:
		return entity.KeyValid
	default:
		return entity.KeyUnknown
	}
}
