// Package embedding calls the local sentence-embedding daemon
// (scripts/embed_server.py, bge-small) used for idea de-duplication.
package embedding

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
)

// DefaultURL is the daemon's embed endpoint.
const DefaultURL = "http://127.0.0.1:4330/embed"

// Client embeds texts.
type Client struct {
	http *http.Client
	url  string
}

// New returns a client for url.
func New(httpClient *http.Client, url string) *Client {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}

	return &Client{http: httpClient, url: url}
}

// Embed returns the vector of one text.
func (c *Client) Embed(ctx context.Context, text string) ([]float64, error) {
	body, err := json.Marshal(map[string][]string{"texts": {text}})
	if err != nil {
		return nil, fmt.Errorf("encoding embed request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("building embed request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("embed daemon: %w", err)
	}

	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 150))
		return nil, fmt.Errorf("embed daemon %d: %s", resp.StatusCode, b)
	}

	var out struct {
		Vectors [][]float64 `json:"vectors"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("decoding embed response: %w", err)
	}

	if len(out.Vectors) == 0 {
		return nil, errors.New("embed daemon returned no vector")
	}

	return out.Vectors[0], nil
}

// Cosine is the cosine similarity of a and b (0 when either is all zeros).
func Cosine(a, b []float64) float64 {
	var dot, na, nb float64
	for i := range min(len(a), len(b)) {
		dot += a[i] * b[i]
		na += a[i] * a[i]
		nb += b[i] * b[i]
	}

	d := math.Sqrt(na) * math.Sqrt(nb)
	if d == 0 {
		d = 1
	}

	return dot / d
}
